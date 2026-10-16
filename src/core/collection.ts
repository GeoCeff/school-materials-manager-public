import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, link, mkdir, open, readFile, realpath, readdir, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { archiveRelative, within } from './paths.js';
import type { CollectionFailureKind, CollectionItem, CollectionJob, CollectionOptions, CollectionPlan, CollectionPreflight, CollectionSnapshot, CollectionSource, CourseMapping } from './collection-model.js';

export const collectionFileLimit = 100 * 1024 * 1024;
export const collectionItemLimit = 1000;
const runLimit = 2 * 1024 ** 3;
const allowedExtensions = new Set(['.pdf','.docx','.pptx','.md','.txt','.c','.h','.cpp','.py','.kt','.js','.ts','.zip','.png','.jpg','.jpeg','.webp','.xlsx','.csv','.doc','.ppt','.odt','.ods','.odp']);
export class CollectionError extends Error { constructor(message: string, public readonly kind: CollectionFailureKind) { super(message); } }
class CatalogError extends Error {}
export function collectionMapping(plan: CollectionPlan, item: CollectionItem): CourseMapping {
  return plan.mappings?.find(mapping => mapping.courseId === item.courseId) ?? { courseId: item.courseId, year: plan.year, semester: plan.semester, subject: item.course };
}
function itemFolder(plan: CollectionPlan, item: CollectionItem, destination: string): string {
  const mapping = collectionMapping(plan, item);
  return join(destination, ...[mapping.year || 'Unclassified', mapping.semester || 'Unclassified', mapping.subject || 'Unclassified', item.bucket].map(collectionName));
}
function itemTarget(plan: CollectionPlan, item: CollectionItem, destination: string, hash: string): string {
  const resource = createHash('sha256').update(item.key).digest('hex').slice(0,12);
  return join(itemFolder(plan,item,destination), `${collectionName(item.title)} [${resource}]-${hash.slice(0,16)}${item.extension}`);
}
function noteBody(item: CollectionItem): string {
  return `${item.title}\n${'='.repeat(Math.min(item.title.length,70))}\n\n${item.text ?? ''}\n\nCourse: ${item.course}\nSource: ${item.sourceURL || 'User-selected local material'}\nRepresentation: ${item.kind === 'reference' ? 'Reference only; linked content was not downloaded.' : 'Course text captured from its API; attachments are separate items.'}\n`;
}
export function collectableExtension(extension: string): boolean { return allowedExtensions.has(extension); }
export function collectionName(value: string): string {
  const name = value.normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '_').replace(/^[. ]+|[. ]+$/g, '').slice(0, 70).replace(/[. ]+$/g, '');
  return !name || /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(name) ? `_${name || 'Untitled'}` : name;
}
export function collectionURL(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !['classroom.google.com','drive.google.com','docs.google.com','www.youtube.com','youtu.be','uvec.upcebu.edu.ph'].includes(url.hostname)) return '';
    const safe = new URL(url.origin + url.pathname);
    if (url.hostname === 'uvec.upcebu.edu.ph' && /^\/course\/view\.php$/.test(url.pathname) && /^\d+$/.test(url.searchParams.get('id') ?? '')) safe.searchParams.set('id', url.searchParams.get('id')!);
    if (url.hostname === 'www.youtube.com' && /^[\w-]{1,30}$/.test(url.searchParams.get('v') ?? '')) safe.searchParams.set('v', url.searchParams.get('v')!);
    return safe.href;
  } catch { return ''; }
}
export async function collectionDirectory(path: string): Promise<string> {
  if (!isAbsolute(path) || /^\\\\/.test(path)) throw new Error('Use a local archive folder, not a network share.');
  const canonical = await realpath(path);
  if (canonical !== resolve(path) || (await lstat(path)).isSymbolicLink() || !(await stat(path)).isDirectory()) throw new Error('Collection folders cannot be links or redirected paths.');
  return canonical;
}
async function directory(root: string, parts: string[]): Promise<string> {
  await collectionDirectory(root);
  let path = root;
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || /[\\/:\0]/.test(part)) throw new Error('Invalid collection destination.');
    path = join(path, part);
    try { await mkdir(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if (!within(root, path) || await realpath(path) !== path || (await lstat(path)).isSymbolicLink()) throw new Error('A collection folder was replaced by a link.');
  }
  return path;
}
async function fingerprint(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  let count = 0;
  for await (const bytes of createReadStream(path, { signal })) { count += bytes.length; if (count > collectionFileLimit) throw new Error('A local version exceeds the verification size limit.'); hash.update(bytes); }
  return hash.digest('hex');
}
function publicPlan(plan: CollectionPlan | null): CollectionPlan | null {
  return plan ? { ...plan, items: plan.items.map(({ localPath, downloadURL, fileId, exportMime, text, ...item }) => item) } : null;
}
export class CollectionService {
  private db!: DatabaseSync;
  private plan: CollectionPlan | null = null;
  private job: CollectionJob | null = null;
  private running?: Promise<void>;
  private reviewing?: Promise<void>;
  private reviewController?: AbortController;
  private controller?: AbortController;
  private stopState: 'paused' | 'cancelled' = 'paused';
  constructor(private data: string, private download: (item: CollectionItem, signal: AbortSignal) => Promise<string>, private changed: () => void = () => {}) {}
  async init(): Promise<void> {
    await mkdir(this.data, { recursive: true });
    const downloads = await directory(this.data, ['downloads']);
    for (const entry of await readdir(downloads, { withFileTypes: true })) {
      if (entry.isFile() && /^[a-f0-9-]{36}\.part$/.test(entry.name)) { const partial = join(downloads, entry.name); if (Date.now() - (await lstat(partial)).mtimeMs > 24 * 3600_000) await rm(partial); }
    }
    this.db = new DatabaseSync(join(this.data, 'collection.sqlite'));
    const schema = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (schema.user_version > 2) throw new Error('This collection catalog needs a newer application. It was not changed.');
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS collection_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS collection_items (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS collection_destinations (root TEXT NOT NULL, account TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(root,account));
      CREATE TABLE IF NOT EXISTS collection_versions (root TEXT NOT NULL, account TEXT NOT NULL, resource TEXT NOT NULL, revision TEXT NOT NULL, hash TEXT NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL, acquired TEXT NOT NULL, PRIMARY KEY(root,account,resource,revision,hash,path));`);
    if (schema.user_version === 1) {
      this.db.exec('BEGIN IMMEDIATE');
      try { this.db.exec(`ALTER TABLE collection_versions RENAME TO collection_versions_old;
        CREATE TABLE collection_versions (root TEXT NOT NULL, account TEXT NOT NULL, resource TEXT NOT NULL, revision TEXT NOT NULL, hash TEXT NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL, acquired TEXT NOT NULL, PRIMARY KEY(root,account,resource,revision,hash,path));
        INSERT INTO collection_versions SELECT * FROM collection_versions_old; DROP TABLE collection_versions_old; PRAGMA user_version=2; COMMIT`); }
      catch (error) { this.db.exec('ROLLBACK'); throw error; }
    } else this.db.exec('PRAGMA user_version=2');
    const saved = this.get<CollectionPlan>('plan');
    if (saved) this.plan = { ...saved, items: (this.db.prepare('SELECT value FROM collection_items ORDER BY rowid').all() as { value: string }[]).map(row => JSON.parse(row.value)) };
    this.job = this.get<CollectionJob>('job');
    if (this.job?.state === 'running') { this.job.state = 'interrupted'; this.job.current = null; this.job.message = 'Collection was interrupted. Resume to verify and continue.'; this.set('job', this.job); }
  }
  private get<T>(key: string): T | null { const row = this.db.prepare('SELECT value FROM collection_state WHERE key=?').get(key) as { value: string } | undefined; return row ? JSON.parse(row.value) as T : null; }
  private set(key: string, value: unknown): void { this.db.prepare('INSERT OR REPLACE INTO collection_state VALUES (?,?)').run(key, JSON.stringify(value)); }
  private saveItem(item: CollectionItem): void { this.db.prepare('INSERT OR REPLACE INTO collection_items VALUES (?,?)').run(item.id, JSON.stringify(item)); }
  snapshot(): CollectionSnapshot { return { plan: publicPlan(this.plan), job: this.job ? structuredClone(this.job) : null }; }
  progress(): CollectionJob | null { return this.job ? structuredClone(this.job) : null; }
  details(): CollectionPlan | null { return this.plan ? structuredClone(this.plan) : null; }
  private idle(): void { if (this.running) throw new Error('Pause or cancel the current collection first.'); }
  async prepare(root: string, source: CollectionSource, account: string, label: string, items: CollectionItem[], options: CollectionOptions, gaps: string[] = [], signal?: AbortSignal): Promise<void> {
    this.idle(); root = await collectionDirectory(root);
    signal?.throwIfAborted();
    if (!items.length) throw new Error('No materials were found in this selection.');
    if (items.length > collectionItemLimit) throw new Error('Review at most 1,000 resources per collection. Select fewer courses.');
    if (account.length > 200 || label.length > 200 || options.year.length > 70 || options.semester.length > 70) throw new Error('Collection labels are too long.');
    const ids = new Set<string>();
    for (const item of items) {
      if (ids.has(item.id) || !item.id || item.title.length > 1000 || item.key.length > 300 || !['local','file','note','reference'].includes(item.kind) || (item.size!==null&&(!Number.isSafeInteger(item.size)||item.size<0)) ||
          !/^[\w.-]{1,200}$/.test(item.courseId) || !allowedExtensions.has(item.extension) || (['reference','note'].includes(item.kind) && item.extension !== '.md') || (item.text?.length ?? 0) > 250_000) throw new Error('Invalid material inventory.');
      ids.add(item.id); item.state = 'ready'; item.sourceURL = collectionURL(item.sourceURL);
    }
    if (Buffer.byteLength(JSON.stringify(items)) > 8 * 1024 ** 2) throw new Error('Review metadata exceeds 8 MiB. Select fewer materials.');
    const plan: CollectionPlan = { id: randomUUID(), root, source, account, label, year: options.year, semester: options.semester, created: new Date().toISOString(), items, gaps };
    plan.mappings = [...new Map(items.map(item => [item.courseId, this.get<CourseMapping>(`mapping:${root}:${source}:${account}:${item.courseId}`) ?? collectionMapping(plan,item)])).values()];
    this.db.exec('BEGIN IMMEDIATE');
    try { this.db.exec('DELETE FROM collection_items'); for (const item of items) this.saveItem(item); this.set('plan', { ...plan, items: [] }); this.set('job', null); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.plan = plan; this.job = null;
    this.changed();
  }
  async prepareLocal(root: string, paths: string[], options: CollectionOptions & { school: 'manual' | 'uvec'; course: string }): Promise<void> {
    this.idle(); if (this.reviewController) throw new Error('Finish or cancel the current file review first.');
    if (paths.length > collectionItemLimit) throw new Error('Review at most 1,000 resources per collection. Select fewer files.');
    const controller = this.reviewController = new AbortController();
    const signal = AbortSignal.any([controller.signal,AbortSignal.timeout(120_000)]);
    const work = this.reviewing = (async()=>{
      const items: CollectionItem[] = []; const gaps: string[] = []; let bytes = 0;
      for (const path of paths) {
        signal.throwIfAborted();
        const info = await lstat(path); const extension = extname(path).toLowerCase();
        if (!info.isFile() || info.isSymbolicLink() || await realpath(path) !== path || !allowedExtensions.has(extension) || info.size > collectionFileLimit) { gaps.push(`${collectionName(basename(path))}: unsupported, linked, or exceeds 100 MiB.`); continue; }
        bytes += info.size; if (bytes > runLimit) throw new Error('Review at most 2 GiB of local materials at once. Select fewer files.');
        items.push({ id: randomUUID(), key: createHash('sha256').update(path).digest('hex'), courseId: 'local', course: options.course || 'Unclassified', title: basename(path, extname(path)), kind: 'local', bucket: '03 Readings and References', extension, revision: `${info.size}:${info.mtimeMs}`, sourceURL: options.school === 'uvec' ? 'https://uvec.upcebu.edu.ph/' : '', size: info.size, localPath: path, state: 'ready' });
      }
      for (const item of items) { signal.throwIfAborted(); item.revision += `:${await fingerprint(item.localPath!,signal)}`; }
      signal.throwIfAborted();
      await this.prepare(root, 'manual', options.school, options.school === 'uvec' ? 'UVEC manual downloads' : 'Files you selected', items, options, gaps, signal);
    })();
    try { await work; } finally { if (this.reviewController === controller) { this.reviewController = undefined; this.reviewing = undefined; } }
  }
  async start(ids: string[]): Promise<void> {
    this.idle(); if (!this.plan || !ids.length || new Set(ids).size !== ids.length || ids.some(id => !this.plan!.items.some(item => item.id === id))) throw new Error('Select materials from the current review.');
    const preflight = await this.preflight(ids); if (preflight.problems.length) throw new Error(preflight.problems[0]);
    const selected = new Set(ids);
    const items = this.plan.items.map(item => ({...item, state: (selected.has(item.id) ? 'ready' : 'excluded') as CollectionItem['state'], message: undefined, failure: undefined}));
    const job: CollectionJob = { id: randomUUID(), planId: this.plan.id, state: 'running', processed: 0, total: ids.length, published: 0, unchanged: 0, failed: 0, bytes: 0, current: null, message: '', started: new Date().toISOString() };
    this.db.exec('BEGIN IMMEDIATE');
    try { for (const item of items) this.saveItem(item); this.set('job',job); this.db.exec('COMMIT'); } catch(error) { this.db.exec('ROLLBACK'); throw error; }
    this.plan.items = items; this.job = job; this.launch();
  }
  stop(action: 'pause' | 'cancel'): void { this.stopState = action === 'pause' ? 'paused' : 'cancelled'; this.controller?.abort(); this.reviewController?.abort(); }
  async resume(retryOnly = false, temporaryOnly = false): Promise<void> {
    this.idle(); if (!this.plan || !this.job || !(retryOnly ? this.plan.items.some(item => item.state === 'failed' && (!temporaryOnly || item.failure === 'temporary')) : ['paused','interrupted'].includes(this.job.state))) throw new Error('There is no collection to resume or retry.');
    const items = this.plan.items.map(item => item.state === 'failed' && (!temporaryOnly || item.failure === 'temporary') ? {...item,state:'ready' as const,message:undefined,failure:undefined} : {...item});
    const job: CollectionJob = {...this.job, failed:items.filter(item=>item.state==='failed').length, processed:items.filter(item=>['published','unchanged','failed'].includes(item.state)).length, started:new Date().toISOString(),state:'running',message:''};
    this.db.exec('BEGIN IMMEDIATE');
    try { for (const item of items) this.saveItem(item); this.set('job',job); this.db.exec('COMMIT'); } catch(error) { this.db.exec('ROLLBACK'); throw error; }
    this.plan.items = items; this.job = job; this.launch();
  }
  async organize(mappings: CourseMapping[]): Promise<void> {
    this.idle(); if (!this.plan || this.job && ['paused','interrupted'].includes(this.job.state)) throw new Error('Finish or cancel the paused collection before changing its organization.');
    const ids = new Set(this.plan.items.map(item=>item.courseId));
    if (!Array.isArray(mappings) || mappings.length !== ids.size || new Set(mappings.map(mapping=>mapping.courseId)).size !== ids.size || mappings.some(mapping=>!ids.has(mapping.courseId) || ['year','semester','subject'].some(key=>typeof mapping[key as keyof CourseMapping] !== 'string' || mapping[key as keyof CourseMapping].length > (key==='subject'?200:70) || /[\x00-\x1f]/.test(mapping[key as keyof CourseMapping])))) throw new Error('Invalid course organization.');
    const plan = {...this.plan,mappings:structuredClone(mappings)};
    this.db.exec('BEGIN IMMEDIATE');
    try { this.set('plan',{...plan,items:[]}); for(const mapping of mappings) this.set(`mapping:${plan.root}:${plan.source}:${plan.account}:${mapping.courseId}`,mapping); this.db.exec('COMMIT'); }
    catch(error) { this.db.exec('ROLLBACK'); throw error; } this.plan=plan; this.changed();
  }
  async preflight(ids: string[]): Promise<CollectionPreflight> {
    if (!this.plan || !Array.isArray(ids) || !ids.length || ids.length>collectionItemLimit || new Set(ids).size!==ids.length || ids.some(id=>!this.plan!.items.some(item=>item.id===id))) throw new Error('Select materials from the current review.');
    const plan=this.plan; await collectionDirectory(plan.root);
    const row=this.db.prepare('SELECT id FROM collection_destinations WHERE root=? AND account=?').get(plan.root,`${plan.source}:${plan.account}`) as {id:string}|undefined;
    const destination=join(plan.root,'Collected',`${plan.source}-${row?.id.slice(0,8) ?? '00000000'}`);
    const storage=await statfs(plan.root); const freeBytes=Number(storage.bavail)*Number(storage.bsize); let estimatedBytes=0; let unknownSizes=0;
    const items=plan.items.filter(item=>ids.includes(item.id)).map(item=>{
      const path=itemTarget(plan,item,destination,'0000000000000000'); const size=['note','reference'].includes(item.kind)?Buffer.byteLength(noteBody(item)):item.size;
      estimatedBytes+=size??collectionFileLimit; if(size===null)unknownSizes++;
      return {id:item.id,path:relative(plan.root,path),problem:path.length>240?'Destination path exceeds 240 characters. Shorten the archive root or course labels.':size!==null&&size>collectionFileLimit?'File exceeds the 100 MiB collection limit.':null};
    });
    const problems=items.flatMap(item=>item.problem?[item.problem]:[]);
    if(freeBytes<512*1024**2+Math.min(estimatedBytes,runLimit)*2)problems.push('Insufficient free space for the selected materials and staging. Keep at least 512 MiB free.');
    return {planId:plan.id,items,estimatedBytes,unknownSizes,freeBytes,problems:[...new Set(problems)]};
  }
  private commitItem(item: CollectionItem, state: 'published'|'unchanged', path: string, bytes: number, hash?: string, receiptKey?: string): void {
    const plan=this.plan!; const job=this.job!; const nextItem={...item,state,path,message:undefined,failure:undefined};
    const nextJob={...job,processed:job.processed+1,published:job.published+(state==='published'?1:0),unchanged:job.unchanged+(state==='unchanged'?1:0),bytes:job.bytes+(state==='published'?bytes:0)};
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if(hash)this.db.prepare('INSERT OR IGNORE INTO collection_versions VALUES (?,?,?,?,?,?,?,?)').run(plan.root,`${plan.source}:${plan.account}`,item.key,item.revision,hash,path,bytes,new Date().toISOString());
      this.saveItem(nextItem);this.set('job',nextJob);if(receiptKey)this.set(receiptKey,null);this.db.exec('COMMIT');
    } catch { this.db.exec('ROLLBACK'); throw new CatalogError('The collection catalog could not save progress. Verified copies and recovery receipts were retained. Resume when local storage is available.'); }
    Object.assign(item,nextItem);Object.assign(job,nextJob);
  }
  private launch(): void {
    this.controller = new AbortController();
    this.running = this.run(this.controller.signal).catch(()=>{
      // If even the pause checkpoint cannot be written, retain memory state and let the durable receipt reconcile on restart.
      if(this.job){this.job.state='paused';this.job.current=null;this.job.message='Local collection storage could not save progress. Verified files were retained. Resume after checking local storage.';}
    }).finally(() => { this.running = undefined; this.controller = undefined; this.changed(); });
    this.changed();
  }
  async whenIdle(): Promise<void> { await this.running; await this.reviewing?.catch(()=>{}); }
  private async destination(plan: CollectionPlan): Promise<string> {
    let row = this.db.prepare('SELECT id FROM collection_destinations WHERE root=? AND account=?').get(plan.root, `${plan.source}:${plan.account}`) as { id: string } | undefined;
    const fresh = !row; if (!row) row = { id: randomUUID() };
    const parts = ['Collected', `${plan.source}-${row.id.slice(0,8)}`];
    const container = await directory(plan.root, [parts[0]!]);
    if (fresh) await mkdir(join(container, parts[1]!));
    const target = await directory(plan.root, parts);
    const marker = join(target, '.archive-search-owner');
    if (fresh) { const file = await open(marker, 'wx'); try { await file.writeFile(row.id); await file.sync(); } finally { await file.close(); } this.db.prepare('INSERT INTO collection_destinations VALUES (?,?,?)').run(plan.root, `${plan.source}:${plan.account}`, row.id); }
    if ((await lstat(marker)).isSymbolicLink() || await readFile(marker, 'utf8') !== row.id) throw new Error('Managed collection ownership could not be verified.');
    return target;
  }
  private async run(signal: AbortSignal): Promise<void> {
    const plan = this.plan!; const job = this.job!;
    let runBytes = 0;
    try {
      const destination = await this.destination(plan);
      const staging = await directory(destination, ['.staging']);
      const owner = await readFile(join(destination, '.archive-search-owner'), 'utf8');
      for (const entry of await readdir(staging, { withFileTypes: true })) {
        if (entry.isFile() && /^[a-f0-9-]{36}\.part$/.test(entry.name)) { const partial = join(staging, entry.name); if (Date.now() - (await lstat(partial)).mtimeMs > 24 * 3600_000) { await collectionDirectory(staging); await rm(partial); } }
      }
      // ponytail: serialize transfers for predictable cancellation and quotas; parallelize only after real-provider measurements.
      for (const item of plan.items) {
        signal.throwIfAborted();
        if (item.state !== 'ready') continue;
        if (Date.now() - Date.parse(job.started) > 30 * 60_000) { job.message = 'Run time limit reached. Resume for another bounded run.'; job.state = 'paused'; break; }
        job.current = item.title; this.changed();
        let temporary: string | undefined; let downloaded: string | undefined; let cachedSource: string | undefined; let cachedHash: string | undefined;
        try {
          if (item.size !== null && item.size > collectionFileLimit) throw new Error('File exceeds the 100 MiB collection limit.');
          const receiptKey = `receipt:${plan.id}:${item.id}`;
          const receipt = this.get<{ path: string; hash: string; bytes: number }>(receiptKey);
          if (receipt && join(plan.root,receipt.path) === itemTarget(plan,item,destination,receipt.hash)) {
            const recovered = join(plan.root, receipt.path);
            try {
              if (await realpath(recovered) === recovered && !(await lstat(recovered)).isSymbolicLink() && await fingerprint(recovered, signal) === receipt.hash) {
                this.commitItem(item,'published',receipt.path,receipt.bytes,receipt.hash,receiptKey);
                this.changed(); continue;
              }
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          }
          const versions = this.db.prepare('SELECT hash,path,size FROM collection_versions WHERE root=? AND account=? AND resource=? AND revision=? ORDER BY acquired DESC LIMIT 100').all(plan.root, `${plan.source}:${plan.account}`, item.key, item.revision) as { hash: string; path: string; size: number }[];
          let unchanged: typeof versions[number] | undefined;
          if (item.kind !== 'local') for (const old of versions) {
            const path = join(plan.root,old.path); let valid=false;
            try { valid=within(destination,path) && await realpath(path)===path && !(await lstat(path)).isSymbolicLink() && await fingerprint(path,signal)===old.hash; } catch {}
            if(!valid)continue;
            if(path===itemTarget(plan,item,destination,old.hash)){unchanged=old;break;}
            if(item.kind==='file'&&!cachedSource){cachedSource=path;cachedHash=old.hash;}
          }
          if(unchanged){this.commitItem(item,'unchanged',unchanged.path,0);this.changed();continue;}
          if (runBytes + (item.size ?? collectionFileLimit) > runLimit) { job.state = 'paused'; job.message = 'The 2 GiB run budget was reached.'; break; }
          const usage = this.db.prepare('SELECT COALESCE(SUM(size),0) AS bytes FROM (SELECT MAX(size) AS size FROM collection_versions WHERE root=? GROUP BY path)').get(plan.root) as { bytes: number };
          if (Number(usage.bytes) + (item.size ?? collectionFileLimit) > 10 * 1024 ** 3) { job.state = 'paused'; job.message = 'The 10 GiB catalog budget was reached. Review local storage before continuing.'; break; }
          signal.throwIfAborted();
          const storage = await statfs(destination); if (Number(storage.bavail) * Number(storage.bsize) < 512 * 1024 ** 2 + (item.size ?? collectionFileLimit) * 2) throw new Error('Insufficient free space: keep 512 MiB free beyond staging.');
          temporary = join(staging, `${randomUUID()}.part`);
          if (await readFile(join(destination, '.archive-search-owner'), 'utf8') !== owner) throw new Error('Managed collection ownership changed.');
          const hash = createHash('sha256'); let bytes = 0;
          const file = await open(temporary, 'wx');
          try {
            let input: AsyncIterable<Buffer>;
            let before: Awaited<ReturnType<typeof stat>> | undefined;
            if (item.kind === 'note' || item.kind === 'reference') {
              const body = noteBody(item);
              input = (async function* () { yield Buffer.from(body, 'utf8'); })();
            } else {
              const source = item.kind === 'local' ? item.localPath! : cachedSource ?? (downloaded = await this.download(item, signal));
              if (item.kind === 'file' && !cachedSource && !within(join(this.data, 'downloads'), source)) throw new Error('Invalid download receipt.');
              before = await stat(source);
              if (item.kind === 'local' && !item.revision.startsWith(`${before.size}:${before.mtimeMs}:`)) throw new CollectionError('The selected file changed after review. Choose it again.','changed');
              if (!(await lstat(source)).isFile() || (await lstat(source)).isSymbolicLink() || await realpath(source) !== source) throw new Error('The selected material is no longer a regular local file.');
              input = createReadStream(source, { signal });
            }
            for await (const chunk of input) {
              signal.throwIfAborted(); bytes += chunk.length;
              if (bytes > collectionFileLimit || runBytes + bytes > runLimit) throw new Error('Collection byte limit exceeded.');
              hash.update(chunk); await file.writeFile(chunk);
            }
            if (item.kind === 'local') { const after = await stat(item.localPath!); if (!before || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino || bytes !== after.size) throw new Error('The selected file changed during import. Review it again.'); }
            if (item.kind === 'file' && bytes === 0) throw new Error('The provider returned an empty download.');
            await file.sync();
          } finally { await file.close(); }
          signal.throwIfAborted(); const digest = hash.digest('hex');
          if (item.kind === 'local' && digest !== item.revision.split(':')[2]) throw new CollectionError('The selected file changed after review. Choose it again.','changed');
          if(cachedSource&&digest!==cachedHash)throw new CollectionError('A retained copy changed while it was being reused. Review the source again.','changed');
          if (process.platform === 'win32' && (item.kind === 'file' || item.kind === 'local')) {
            try { await writeFile(`${temporary}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\n', { flag: 'wx' }); }
            catch { throw new Error('Windows download trust metadata could not be saved. Use a local NTFS destination.'); }
          }
          const target = itemTarget(plan,item,destination,digest);
          const folder = await directory(destination,relative(destination,dirname(target)).split(/[\\/]/));
          if (target.length > 240) throw new Error('Destination path is too long. Choose a shorter archive root or course label.');
          await collectionDirectory(folder); await collectionDirectory(staging); signal.throwIfAborted();
          if (await readFile(join(destination, '.archive-search-owner'), 'utf8') !== owner) throw new Error('Managed collection ownership changed.');
          this.set(receiptKey, { path: relative(plan.root, target), hash: digest, bytes });
          // A same-volume hard link publishes complete bytes without replacing an existing name; the staging link is then removed.
          try { await link(temporary, target); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || (await lstat(target)).isSymbolicLink() || await realpath(target) !== target || await fingerprint(target, signal) !== digest) throw new Error('A destination conflict was preserved. No existing file was overwritten.');
          }
          const path = relative(plan.root, target);
          this.commitItem(item,'published',path,bytes,digest,receiptKey);runBytes+=bytes;
        } catch (error) {
          if (signal.aborted || error instanceof CatalogError) throw error;
          const nextItem={...item,state:'failed' as const,failure:error instanceof CollectionError?error.kind:'permanent' as const,message:error instanceof Error?error.message.slice(0,300):'Material could not be collected.'};
          this.saveItem(nextItem);Object.assign(item,nextItem);job.failed++;job.processed++;
        } finally {
          if (temporary) await rm(temporary, { force: true }).catch(() => {});
          if (downloaded && within(join(this.data, 'downloads'), downloaded)) await rm(downloaded, { force: true }).catch(() => {});
          this.set('job', job); this.changed();
        }
      }
      if (job.state === 'running') { job.state = job.failed || plan.gaps.length ? 'completed-with-gaps' : 'completed'; job.message = 'Complete files are in Collected. Refresh the search index to make supported content searchable.'; }
    } catch (error) {
      job.state = signal.aborted ? this.stopState : 'paused'; job.message = signal.aborted ? 'Verified copies were retained. Partial files were not published.' : error instanceof Error ? error.message : 'Collection stopped safely.';
    } finally { job.current = null; this.set('job', job); this.changed(); }
  }
  async close(): Promise<void> { this.stop('pause'); await this.whenIdle(); if (this.db?.isOpen) this.db.close(); }
  private removalOwners(root: string): { account: string; id: string }[] {
    const owners = this.db.prepare('SELECT account,id FROM collection_destinations WHERE root=? LIMIT 10001').all(root) as { account: string; id: string }[];
    if (owners.length > 10000 || owners.some(row => typeof row.account !== 'string' || !/^(manual|google|uvec):.{1,200}$/.test(row.account) || typeof row.id !== 'string' || !/^[a-f0-9-]{36}$/.test(row.id))) throw new Error('Managed ownership records cannot be verified. Preserve the catalog for recovery.');
    return owners;
  }
  async removalCopies(root: string | null): Promise<{ copies: { path: string; hash: string }[]; preserved: string[] }> {
    this.idle();
    if (!root) return { copies: [], preserved: [] };
    const rows = this.db.prepare('SELECT DISTINCT path,hash,account FROM collection_versions WHERE root=? LIMIT 10001').all(root) as { path: string; hash: string; account: string }[];
    // Durable publication receipts can outlive an interrupted catalog transaction.
    if (this.plan?.root === root) for (const row of this.db.prepare("SELECT value FROM collection_state WHERE key LIKE 'receipt:%' LIMIT 10001").all() as { value: string }[]) {
      const receipt = JSON.parse(row.value);
      if (receipt === null) continue;
      if (typeof receipt.path !== 'string' || typeof receipt.hash !== 'string') throw new Error('Publication receipts cannot be verified. Preserve the catalog for recovery.');
      rows.push({ ...receipt, account: `${this.plan.source}:${this.plan.account}` });
    }
    for (const owner of this.removalOwners(root)) {
      const base = join(root, 'Collected', `${owner.account.split(':')[0]}-${owner.id.slice(0,8)}`); const staging = join(base, '.staging');
      try {
        await collectionDirectory(root); await collectionDirectory(join(root,'Collected')); await collectionDirectory(base); await collectionDirectory(staging);
        const marker = join(base, '.archive-search-owner');
        if ((await lstat(marker)).isSymbolicLink() || await readFile(marker, 'utf8') !== owner.id) throw new Error('Managed staging ownership changed.');
        for (const name of await readdir(staging)) if (/^[a-f0-9-]{36}\.part$/.test(name)) {
          const target = join(staging,name); const info = await lstat(target);
          if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || await realpath(target) !== target) throw new Error('Unverified staging file was preserved.');
          rows.push({ path: relative(root, join(staging,name)), hash: await fingerprint(join(staging,name)), account: owner.account });
          if (rows.length > 10000) throw new Error('Too many managed copies for one safe removal review.');
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    if (rows.length > 10000) throw new Error('Too many managed copies for one safe removal review.');
    if (rows.some(row => typeof row.path !== 'string' || row.path.length > 32768 || typeof row.hash !== 'string' || typeof row.account !== 'string')) throw new Error('Managed-copy records cannot be verified. Preserve the catalog for recovery.');
    const copies = new Map<string, { path: string; hash: string }>(); const preserved = new Set<string>();
    for (const row of rows) {
      try { await this.verifyRemovalCopy(root, row.path, row.hash, row.account); copies.set(row.path, { path: row.path, hash: row.hash }); }
      catch { preserved.add(row.path); }
    }
    for (const path of preserved) copies.delete(path);
    return { copies: [...copies.values()].sort((a,b) => a.path.localeCompare(b.path)), preserved: [...preserved].sort() };
  }
  async verifyRemovalCopy(root: string, path: string, hash: string, account?: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid managed-copy fingerprint.');
    const slashes = path.replaceAll('\\', '/');
    const normalized = /^Collected\/(?:manual|google|uvec)-[a-f0-9]{8}\/\.staging\/[a-f0-9-]{36}\.part$/.test(slashes) ? slashes : archiveRelative(path);
    const parts = normalized.split('/');
    const destinations = this.removalOwners(root);
    const owner = destinations.find(row => (!account || row.account === account) && parts[0] === 'Collected' && parts[1] === `${row.account.split(':')[0]}-${row.id.slice(0,8)}`);
    if (!owner || parts.length < 3) throw new Error('Copy ownership could not be verified.');
    await collectionDirectory(root);
    for (let index = 1; index < parts.length; index++) await collectionDirectory(join(root, ...parts.slice(0,index)));
    const marker = join(root, ...parts.slice(0,2), '.archive-search-owner');
    if (!(await lstat(marker)).isFile() || (await lstat(marker)).isSymbolicLink() || await readFile(marker, 'utf8') !== owner.id) throw new Error('Copy ownership changed.');
    const target = join(root, normalized); const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || await realpath(target) !== target || await fingerprint(target) !== hash) throw new Error('Changed, linked or missing copies are preserved.');
  }
  async reloadAfterRemoval(): Promise<void> { this.plan = null; this.job = null; await this.init(); }
}
