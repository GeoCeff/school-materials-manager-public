import { app, dialog, safeStorage, shell, type BrowserWindow } from 'electron';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { authorizeGoogle, googleClient, SchoolProviders, type CollectionCredentials } from './collection-providers.js';
import { CollectionError } from '../core/collection.js';
import { supportedExtensions } from '../core/extract.js';
import { schoolSupport, uvecAdminRequest } from '../core/collection-assistance.js';
import type { CollectionAssistance, CollectionCoverage, CollectionItem, CollectionJob, CollectionOptions, CollectionPlan, CollectionPreflight, CollectionSnapshot, CollectionStatus, CourseMapping, ScanSelection, SourceCourse } from '../core/collection-model.js';
import type { Job, Status } from '../core/model.js';

interface Schedule { enabled: boolean; next: string; selection: ScanSelection; root: string; excluded: string[]; state?: 'waiting'|'running'|'retrying'|'attention'; attempts?: number; planId?: string; lastRun?: string; lastSuccess?: string; message?: string }
interface StoredCredentials extends CollectionCredentials { schedule?: Schedule }
function label(value: unknown, maximum = 200): string { if (typeof value !== 'string' || value.length > maximum || /[\0\x01-\x1f]/.test(value)) throw new Error('Invalid collection input.'); return value; }
function source(value: unknown): 'google' | 'uvec' { if (value !== 'google' && value !== 'uvec') throw new Error('Choose a supported source.'); return value; }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid collection input.'); return value as Record<string, unknown>; }
async function configurationFile(path: string, limit: number): Promise<Buffer> {
  const file = await open(path, 'r');
  try {
    const info = await file.stat(); if (!info.isFile() || info.size > limit) throw new Error('Connection configuration exceeds its safety limit.');
    const bytes = Buffer.alloc(limit + 1); let offset = 0;
    while (offset <= limit) { const read = await file.read(bytes, offset, bytes.length - offset, null); if (!read.bytesRead) break; offset += read.bytesRead; }
    if (offset > limit) throw new Error('Connection configuration exceeds its safety limit.');
    return bytes.subarray(0, offset);
  } finally { await file.close(); }
}
export class DesktopCollection {
  private credentials: StoredCredentials = {};
  private providers!: SchoolProviders;
  private operation?: AbortController;
  private active = new Map<string, CollectionItem>();
  private downloadControllers = new Map<number, AbortController>();
  private approvedPlan?: CollectionPlan;
  private courseList: SourceCourse[] = [];
  private selection?: ScanSelection;
  private exclusions: string[] = [];
  private problem = '';
  private storageProblem = false;
  private timer?: NodeJS.Timeout;
  private scheduling = false;
  private policyEpoch = 0;
  private writes: Promise<void> = Promise.resolve();
  private pendingIndex?: { job: string; root: string };
  private indexedJob = '';
  private bundled = false;
  private reportPreview = '';
  private initializing: Promise<void>;
  private maintaining = false;
  constructor(private data: string, private window: () => BrowserWindow | undefined, private call: <T>(method: string, ...args: unknown[]) => Promise<T>, private notify: () => void, private synthetic: boolean, private bundledClient?: string) {
    this.initializing = this.init();
  }
  private async init(): Promise<void> {
    try {
      const encrypted = await configurationFile(join(this.data, 'connections.bin'), 256_000);
      if (encrypted.length > 256_000 || !safeStorage.isEncryptionAvailable()) throw new Error('Unavailable secure storage.');
      const parsed = JSON.parse(safeStorage.decryptString(encrypted));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || (parsed.google && (typeof parsed.google.refresh !== 'string' || typeof parsed.google.subject !== 'string' || !Array.isArray(parsed.google.scopes))) || (parsed.uvec && (typeof parsed.uvec.token !== 'string' || typeof parsed.uvec.subject !== 'string')) || (parsed.schedule && (!Array.isArray(parsed.schedule.excluded) || !Array.isArray(parsed.schedule.selection?.courseIds) || typeof parsed.schedule.root !== 'string'))) throw new Error('Invalid secure connection data.');
      this.credentials = parsed;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { this.storageProblem = true; this.problem = 'Encrypted connections could not be read. The original file was retained; offline search is unaffected.'; } }
    if(!this.storageProblem && this.bundledClient){
      try { const client=googleClient(JSON.parse((await configurationFile(this.bundledClient,64_000)).toString('utf8')));this.credentials.client??=client;this.bundled=this.credentials.client.client_id===client.client_id; }
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')this.problem='The bundled Google application configuration is invalid. Use manual import or contact the publisher.';}
    }
    this.providers = new SchoolProviders(this.credentials, () => this.persist(), join(this.data, 'downloads'));
    this.timer = setInterval(() => void this.tick().catch(()=>{this.problem='Collection scheduling could not reach local storage. Review the source and archive service before retrying.';this.notify();}), 60_000); this.timer.unref();
  }
  private persist(): Promise<void> {
    this.writes = this.writes.catch(() => {}).then(() => this.writeCredentials()); return this.writes;
  }
  private async writeCredentials(): Promise<void> {
    if (this.storageProblem || !safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable. No plaintext fallback is used.');
    await mkdir(this.data, { recursive: true }); const temporary = join(this.data, `connections-${randomUUID()}.tmp`);
    try { await writeFile(temporary, safeStorage.encryptString(JSON.stringify(this.credentials)), { flag: 'wx' }); await rename(temporary, join(this.data, 'connections.bin')); }
    finally { await rm(temporary, { force: true }); }
  }
  private async root(): Promise<string> { const status = await this.call<Status>('status'); if (!status.root || !status.available) throw new Error('Choose and index an available archive folder first.'); return status.root; }
  private async exclusive<T>(action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    await this.initializing;
    if (this.operation) throw new Error('Finish or cancel the current source operation first.');
    const controller = this.operation = new AbortController(); this.notify();
    try { const result = await action(controller.signal); this.problem = ''; return result; }
    catch (error) { this.problem = error instanceof Error ? error.message : 'The source operation failed.'; throw error; }
    finally { if (this.operation === controller) this.operation = undefined; this.notify(); }
  }
  async status(): Promise<CollectionStatus> {
    await this.initializing; const snapshot = await this.call<CollectionSnapshot>('collection-status');
    const schedule=this.credentials.schedule;
    return { ...snapshot, courses: this.courseList, schools:structuredClone(schoolSupport), connections: { google: { configured: !!this.credentials.client, bundled:this.bundled, connected: !!this.credentials.google, label: this.credentials.google?.label ?? '', attachments: this.credentials.google?.attachments ?? false, announcements: this.credentials.google?.announcements ?? false, submissions: this.credentials.google?.submissions ?? false }, uvec: { connected: !!this.credentials.uvec, label: this.credentials.uvec?.label ?? '' }, authenticating: !!this.operation, problem: this.problem }, schedule: { enabled: schedule?.enabled ?? false, next: schedule?.next ?? null, source: schedule?.selection.source ?? null,state:schedule?.enabled?schedule.state??'waiting':'off',message:schedule?.message??'',lastRun:schedule?.lastRun??null,lastSuccess:schedule?.lastSuccess??null } };
  }
  async assertNotRunning(): Promise<void> {
    let current: CollectionSnapshot;
    try { current = await this.call<CollectionSnapshot>('collection-status'); }
    catch (error) { if (error instanceof Error && error.message.startsWith('Collection data could not be opened.')) return; throw error; }
    if (current.job?.state === 'running') throw new Error('Pause collection before changing the archive or source connection.');
  }
  async configureGoogle(): Promise<void> {
    await this.exclusive(async signal => {
      if (this.synthetic) throw new Error('Real account connections are disabled in the synthetic demo.');
      await this.assertNotRunning();
      const path = (await dialog.showOpenDialog(this.window()!, { title: 'Choose Google OAuth Desktop client JSON', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] })).filePaths[0];
      if (!path) return;
      const raw = await configurationFile(path, 64_000);
      signal.throwIfAborted();
      if (this.credentials.google) throw new Error('Disconnect Google before replacing its OAuth client.');
      const prior = this.credentials.client; this.credentials.client = googleClient(JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, '')));
      try { await this.persist();this.bundled=false; } catch (error) { this.credentials.client = prior; throw error; }
    });
  }
  async connectGoogle(input: unknown): Promise<void> {
    const options = object(input);
    for (const key of ['attachments','announcements','submissions']) if (typeof options[key] !== 'boolean') throw new Error('Invalid Google feature choice.');
    await this.exclusive(async signal => {
      if (this.synthetic) throw new Error('Real account connections are disabled in the synthetic demo.');
      await this.assertNotRunning(); if (!this.credentials.client) throw new Error('Choose a Google OAuth Desktop client JSON first.');
      if (this.credentials.google) throw new Error('Disconnect before choosing another account or changing permissions.');
      const authorized = await authorizeGoogle(this.credentials.client, { attachments: options.attachments as boolean, announcements: options.announcements as boolean, submissions: options.submissions as boolean }, url => shell.openExternal(url), signal);
      signal.throwIfAborted(); this.credentials.google = authorized.connection;
      try { await this.persist(); this.providers.setAccess(authorized.access, authorized.expires); }
      catch (error) { delete this.credentials.google; throw error; }
    });
  }
  async connectUvec(): Promise<void> {
    await this.exclusive(async signal => {
      if (this.synthetic) throw new Error('Real account connections are disabled in the synthetic demo.');
      await this.assertNotRunning(); if (this.credentials.uvec) throw new Error('Disconnect UVEC before changing its token.');
      const path = (await dialog.showOpenDialog(this.window()!, { title: 'School-issued UVEC read-only API token JSON', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] })).filePaths[0];
      if (!path) return; const bytes = await configurationFile(path, 16_000);
      const input = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
      if (input.schoolApprovedReadOnly !== true) throw new Error('A school-approved read-only service is required. See the collection setup guide.');
      const connection = await this.providers.verifyUvec(label(input.token, 128), signal); signal.throwIfAborted();
      this.credentials.uvec = connection; try { await this.persist(); } catch (error) { delete this.credentials.uvec; throw error; }
    });
  }
  cancelAuth(): void { this.operation?.abort(); }
  async disconnect(value: unknown): Promise<void> {
    await this.initializing; const provider = source(value); this.policyEpoch++; this.operation?.abort(); await this.stop('pause'); await this.call('collection-wait');
    const google = this.credentials.google; const prior = this.credentials[provider]; const schedule = this.credentials.schedule;
    delete this.credentials[provider]; if (this.credentials.schedule?.selection.source === provider) delete this.credentials.schedule;
    try { await this.persist(); } catch (error) { if (prior) (this.credentials as Record<string, unknown>)[provider] = prior; this.credentials.schedule = schedule; throw error; }
    this.active.clear(); this.approvedPlan = undefined; this.courseList = []; this.selection = undefined; this.exclusions = []; this.providers.clearAccess();
    this.problem = provider === 'uvec' ? 'Local UVEC access removed. Revoke the school-issued API token in UVEC or through the school administrator. Local copies were kept.' : '';
    if (provider === 'google' && google) {
      const temporary = new SchoolProviders({ ...this.credentials, google }, async () => {}, join(this.data, 'downloads'));
      try { await temporary.revokeGoogle(AbortSignal.timeout(15_000)); } catch { this.problem = 'Local Google credentials removed. The provider grant could not be revoked; remove Archive Search in your Google account permissions. Local copies were kept.'; }
    }
    this.notify();
  }
  async courses(value: unknown): Promise<SourceCourse[]> { const provider = source(value); return this.exclusive(async signal => { await this.assertNotRunning(); this.courseList = await this.providers.courses(provider, signal); return this.courseList; }); }
  private options(input: unknown): CollectionOptions { const value = object(input); return { year: label(value.year, 70), semester: label(value.semester, 70) }; }
  async chooseFiles(input: unknown): Promise<void> {
    const value = object(input); const options = this.options(input); const course = label(value.course, 200); if (!['manual','uvec'].includes(String(value.school))) throw new Error('Invalid manual source.');
    await this.exclusive(async signal => {
      await this.assertNotRunning(); const root = await this.root();
      const files = (await dialog.showOpenDialog(this.window()!, { title: value.school === 'uvec' ? 'Choose your permitted UVEC downloads' : 'Choose school materials to copy', properties: ['openFile','multiSelections'] })).filePaths;
      signal.throwIfAborted(); if (!files.length) return;
      const cancel = () => { void this.call('collection-stop','cancel').catch(()=>{}); };
      signal.addEventListener('abort',cancel,{once:true});
      try { await this.call('collection-local', root, files, { ...options, school: value.school, course }); signal.throwIfAborted(); this.selection = undefined; }
      finally { signal.removeEventListener('abort',cancel); }
    });
  }
  async scan(input: unknown): Promise<void> {
    const value = object(input); const provider = source(value.source); const options = this.options(input);
    if (!Array.isArray(value.courseIds) || !value.courseIds.length || value.courseIds.length > 100 || value.courseIds.some(id => typeof id !== 'string' || !/^[\w-]{1,200}$/.test(id)) || new Set(value.courseIds).size !== value.courseIds.length) throw new Error('Select up to 100 courses from this source.');
    const selection: ScanSelection = { ...options, source: provider, courseIds: value.courseIds as string[] };
    await this.exclusive(async signal => { await this.scanSelection(selection, await this.root(), signal); });
  }
  private async scanSelection(selection: ScanSelection, root: string, signal: AbortSignal): Promise<void> {
    await this.assertNotRunning();
    const courses = await this.providers.courses(selection.source, signal); const chosen = courses.filter(course => selection.courseIds.includes(course.id));
    if (chosen.length !== selection.courseIds.length) throw new Error('One selected course is no longer accessible. Review the course selection.');
    const inventory = await this.providers.scan(selection.source, chosen, signal); signal.throwIfAborted();
    const account = this.credentials[selection.source]; if (!account) throw new Error('Reconnect the selected source.');
    if (root !== await this.root()) throw new Error('The active archive changed. Review again.');
    await this.call('collection-prepare', { ...inventory, ...selection, root, account: account.subject, label: account.label }); this.selection = selection; this.courseList = courses;
  }
  private async review():Promise<CollectionPlan>{
    const plan = await this.call<CollectionPlan | null>('collection-details'); if (!plan || plan.root !== await this.root()) throw new Error('Scan or select files for the current archive first.');
    if (plan.source !== 'manual' && plan.account !== this.credentials[plan.source]?.subject) throw new Error('This review belongs to another account. Reconnect and scan again.');
    return plan;
  }
  private async approve(ids?: string[]): Promise<CollectionPlan> {
    const plan=await this.review();
    this.active = new Map(plan.items.filter(item => ids ? ids.includes(item.id) : item.state === 'ready' || item.state === 'failed').map(item => [item.id, item]));
    this.approvedPlan = plan; return plan;
  }
  async start(input: unknown): Promise<void> {
    if (!Array.isArray(input) || input.length > 1000 || input.some(id => typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id))) throw new Error('Invalid material selection.');
    await this.exclusive(async signal => {
      await this.assertNotRunning(); const plan = await this.approve(input as string[]); signal.throwIfAborted();
      this.exclusions = plan.items.filter(item => !(input as string[]).includes(item.id)).map(item => item.key);
      await this.call('collection-start', input); this.notify();
    });
  }
  async stop(value: unknown): Promise<void> { if (value !== 'pause' && value !== 'cancel') throw new Error('Invalid collection action.'); this.active.clear(); for (const controller of this.downloadControllers.values()) controller.abort(); await this.call('collection-stop', value); this.notify(); }
  async resume(): Promise<void> { await this.exclusive(async signal => { await this.assertNotRunning(); await this.approve(); signal.throwIfAborted(); await this.call('collection-resume'); this.notify(); }); }
  async retryFailed(temporaryOnly=false): Promise<void> { await this.exclusive(async signal=>{await this.assertNotRunning();await this.approve();signal.throwIfAborted();await this.call('collection-retry',temporaryOnly);this.notify();}); }
  async organize(input:unknown):Promise<void>{ await this.exclusive(async()=>{await this.assertNotRunning();await this.review();await this.call('collection-organize',input as CourseMapping[]);}); }
  async preflight(input:unknown):Promise<CollectionPreflight>{await this.initializing;await this.review();return this.call('collection-preflight',input);}
  async assistance():Promise<CollectionAssistance>{await this.initializing;await this.review();return this.call('collection-assistance');}
  async coverage():Promise<CollectionCoverage[]>{
    await this.initializing;const plan=await this.call<CollectionPlan|null>('collection-details');if(!plan)return [];
    const rows=await this.call<{path:string;status:string|null}[]|null>('collection-coverage');const lookup=new Map(rows?.map(row=>[row.path,row.status]));
    return plan.items.map(item=>({id:item.id,state:!['published','unchanged'].includes(item.state)||!item.path?'not-collected':!rows?'index-unavailable':lookup.get(item.path)==='indexed'?'searchable':lookup.get(item.path)==='partial'?'partial':lookup.get(item.path)==='no-text'?'no-text':lookup.get(item.path)==='stale'?'stale':lookup.get(item.path)==='failed'?'failed':!supportedExtensions.has(item.extension)?'unsupported':'pending'}));
  }
  async setupCheck(value:unknown):Promise<{checks:{name:string;state:'ready'|'missing'|'unverified';detail:string}[];request?:string}>{
    const provider=source(value);
    return this.exclusive(async signal=>{
      const checks:{name:string;state:'ready'|'missing'|'unverified';detail:string}[]=[{name:'Secure credential storage',state:!this.storageProblem&&safeStorage.isEncryptionAvailable()?'ready':'missing',detail:'Windows protects connection tokens; local materials and search text are unencrypted.'}];
      if(provider==='google')checks.push({name:'Desktop OAuth application',state:this.credentials.client?'ready':'missing',detail:this.credentials.client?'An application client is configured. Publisher verification and school allowance are separate requirements.':'This build has no Google application configured. The publisher must configure one; advanced users can supply a Desktop client.'});
      checks.push({name:provider==='uvec'?'School-issued restricted token':'Google account consent',state:this.credentials[provider]?'ready':'missing',detail:provider==='uvec'?'Exactly the documented read functions are required. School approval is supplied outside the app.':'Sign in in your system browser and review the requested permissions.'});
      if(this.credentials[provider]){
        if(provider==='uvec')await this.providers.verifyUvec(this.credentials.uvec!.token,signal);
        this.courseList=await this.providers.courses(provider,signal);checks.push({name:'Course API access',state:'ready',detail:'The configured service responded to the permitted course-list request. No attachment was downloaded.'});
      }else checks.push({name:'Course API access',state:'unverified',detail:'Connect before testing API access.'});
      checks.push({name:'Live course pilot',state:'unverified',detail:'Compare a permitted one-course inventory, verify the copies and confirm school state is unchanged.'});
      return {checks,...provider==='uvec'?{request:uvecAdminRequest}:{}};
    });
  }
  async supportText():Promise<string>{
    const status=await this.status();const coverage=await this.coverage();
    const counts=(values:string[],allowed:string[])=>{const safe=values.map(value=>allowed.includes(value)?value:'other');return Object.fromEntries([...new Set(safe)].sort().map(value=>[value,safe.filter(entry=>entry===value).length]));};
    this.reportPreview=JSON.stringify({schema:1,appVersion:app.getVersion(),platform:process.platform,schools:schoolSupport.map(({id,level})=>({id,level})),connections:{googleConfigured:status.connections.google.configured,googleConnected:status.connections.google.connected,uvecConnected:status.connections.uvec.connected,secureStorage:!this.storageProblem&&safeStorage.isEncryptionAvailable()},review:{resourceTypes:counts(status.plan?.items.map(item=>item.kind)??[],['local','file','note','reference']),gapCount:status.plan?.gaps.length??0,failures:counts(status.plan?.items.filter(item=>item.state==='failed').map(item=>item.failure??'permanent')??[],['temporary','attention','changed','permanent'])},coverage:counts(coverage.map(item=>item.state),['searchable','partial','no-text','stale','failed','unsupported','pending','not-collected','index-unavailable']),schedule:{enabled:status.schedule.enabled,state:['off','waiting','running','retrying','attention'].includes(status.schedule.state)?status.schedule.state:'attention'}},null,2);
    return this.reportPreview;
  }
  async exportSupport():Promise<void>{
    if(!this.reportPreview)throw new Error('Preview the sanitized report before exporting it.');const text=this.reportPreview;
    const result=await dialog.showSaveDialog(this.window()!,{title:'Export the previewed sanitized report',defaultPath:'archive-search-support.json',filters:[{name:'JSON',extensions:['json']}]});
    if(!result.canceled&&result.filePath)await writeFile(result.filePath,text,'utf8');
  }
  async download(id: number, supplied: CollectionItem): Promise<string> {
    const controller = new AbortController(); this.downloadControllers.set(id, controller);
    try {
      const item = this.active.get(supplied.id); const plan = this.approvedPlan;
      if (!item || !plan || plan.source === 'manual' || plan.root !== await this.root()) throw new Error('Download is outside the approved collection review.');
      controller.signal.throwIfAborted(); return await this.providers.download(plan.source, item, controller.signal);
    }
    finally { this.downloadControllers.delete(id); }
  }
  abortDownload(id: number): void { this.downloadControllers.get(id)?.abort(); }
  async finished(job: CollectionJob): Promise<void> {
    if (this.maintaining) return;
    if(job.state!=='running'){const current=await this.call<CollectionSnapshot>('collection-status');if(current.job?.id!==job.id||current.job.state!==job.state)return;}
    if (this.maintaining) return;
    if (job.state !== 'running') this.active.clear();
    const policy=this.credentials.schedule;
    if(policy?.enabled&&policy.state==='running'&&policy.planId===job.planId&&job.state!=='running'){
      const plan=await this.call<CollectionPlan|null>('collection-details');
      if(this.credentials.schedule===policy&&policy.state==='running'){
        if(['completed','completed-with-gaps'].includes(job.state)&&!job.failed){policy.state='waiting';policy.attempts=0;policy.lastSuccess=new Date().toISOString();policy.next=new Date(Date.now()+24*3600_000).toISOString();policy.message='Last scheduled collection completed. Coverage limitations remain visible in Review.';}
        else {const temporary=!!plan&&plan.items.some(item=>item.state==='failed')&&plan.items.filter(item=>item.state==='failed').every(item=>item.failure==='temporary');this.scheduleFailure(policy,temporary,'Scheduled collection needs attention. Review failed items or resume the paused collection.');}
        await this.persist().catch(()=>{policy.state='attention';policy.message='Schedule progress could not be saved. Review local storage.';});this.notify();
      }
    }
    const marker=`${job.id}:${job.published}`;
    if (!['completed','completed-with-gaps'].includes(job.state) || !job.published || this.indexedJob === marker || !this.approvedPlan) return;
    this.indexedJob = marker; this.pendingIndex = { job: marker, root: this.approvedPlan.root }; await this.refreshIndex();
  }
  private async refreshIndex(): Promise<void> {
    if (this.maintaining) return;
    if (!this.pendingIndex) return;
    const status = await this.call<Status>('status');
    if (this.maintaining || !this.pendingIndex) return;
    if (status.root !== this.pendingIndex.root) { this.pendingIndex = undefined; return; }
    if (status.job && ['discovering','processing','reconciling'].includes(status.job.state)) return;
    if (status.canRefresh) { const pending=this.pendingIndex;const started=await this.call<Job>('start','refresh');if(this.pendingIndex===pending&&started.id!==status.job?.id)this.pendingIndex=undefined; }
  }
  async schedule(value: unknown): Promise<void> {
    await this.initializing; if (typeof value !== 'boolean') throw new Error('Invalid schedule preference.');
    this.policyEpoch++; if (this.scheduling) this.operation?.abort();
    const previous = this.credentials.schedule ? structuredClone(this.credentials.schedule) : undefined;
    if (value) {
      const current = await this.call<CollectionSnapshot>('collection-status');
      if (!this.selection || !current.plan || current.plan.source !== this.selection.source || current.plan.account !== this.credentials[this.selection.source]?.subject || !current.job || current.job.planId !== current.plan.id || !['completed','completed-with-gaps'].includes(current.job.state)) throw new Error('Complete a reviewed online collection before enabling its daily schedule.');
      this.credentials.schedule = { enabled: true, next: new Date(Date.now() + 24 * 3600_000).toISOString(), selection: structuredClone(this.selection), root: await this.root(), excluded: this.exclusions,state:'waiting',attempts:0,message:'Waiting for the next daily collection.' };
    } else if (this.credentials.schedule) this.credentials.schedule.enabled = false;
    try { await this.persist(); } catch (error) { this.credentials.schedule = previous; throw error; } this.notify();
  }
  private async tick(): Promise<void> {
    if (this.maintaining) return;
    await this.refreshIndex().catch(() => {});
    if (this.synthetic || this.storageProblem || this.scheduling || this.operation || !this.credentials.schedule?.enabled || this.credentials.schedule.state==='attention') return;
    if(this.credentials.schedule.state==='running'){
      const current=await this.call<CollectionSnapshot>('collection-status');if(current.job&&current.job.state!=='running')await this.finished(current.job);return;
    }
    if(Date.parse(this.credentials.schedule.next)>Date.now())return;
    const policy = structuredClone(this.credentials.schedule); const epoch = this.policyEpoch; this.scheduling = true;
    try {
      const current = await this.call<CollectionSnapshot>('collection-status');
      if (policy.root !== await this.root() || current.job?.state === 'running' || (current.plan && (!current.job || ['paused','interrupted'].includes(current.job.state)))) return;
      const retry=policy.state==='retrying'&&current.plan?.id===policy.planId;
      if(!retry)await this.exclusive(async signal => { await this.scanSelection(policy.selection, policy.root, signal); });
      if (epoch !== this.policyEpoch || !this.credentials.schedule?.enabled) return;
      const plan = await this.call<CollectionPlan>('collection-details');const active=this.credentials.schedule;active.state='running';active.planId=plan.id;active.lastRun=new Date().toISOString();active.message=retry?'Retrying temporary failures.':'Collecting approved courses.';await this.persist();
      if(epoch!==this.policyEpoch||!active.enabled)return;
      if(retry)await this.retryFailed(true);else await this.start(plan.items.filter(item => !policy.excluded.includes(item.key)).map(item => item.id));
      const launched=await this.call<CollectionSnapshot>('collection-status');if(launched.job)await this.finished(launched.job);
    } catch(error) { if(epoch===this.policyEpoch&&this.credentials.schedule)this.scheduleFailure(this.credentials.schedule,error instanceof CollectionError&&error.kind==='temporary','Scheduled collection needs attention. Review the source before retrying.'); }
    finally { this.scheduling = false; await this.persist().catch(() => {}); this.notify(); }
  }
  private scheduleFailure(policy:Schedule,temporary:boolean,message:string):void{
    const attempt=policy.attempts??0;
    if(temporary&&attempt<3){policy.attempts=attempt+1;policy.state='retrying';policy.next=new Date(Date.now()+[5,15,60][attempt]!*60_000).toISOString();policy.message=`Temporary failure. Retry ${attempt+1} of 3 is scheduled.`;}
    else {policy.state='attention';policy.message=message;}
  }
  close(): void { if (this.timer) clearInterval(this.timer); this.operation?.abort(); for (const controller of this.downloadControllers.values()) controller.abort(); }
  async maintenance<T>(action: () => Promise<T>): Promise<T> {
    await this.initializing;
    if (this.maintaining || this.operation || this.scheduling || this.downloadControllers.size) throw new Error('Finish the current source operation before clearing local data.');
    this.maintaining = true;
    try { await this.assertNotRunning(); await this.writes; return await action(); }
    finally { this.maintaining = false; }
  }
  async forgetCollectionContext(): Promise<void> {
    // Called after native confirmation and worker validation, before any files are removed.
    const previous = this.credentials.schedule; delete this.credentials.schedule;
    try { if (previous) await this.persist(); } catch (error) { this.credentials.schedule = previous; throw error; }
    this.policyEpoch++; this.active.clear(); this.approvedPlan = undefined; this.courseList = []; this.selection = undefined;
    this.exclusions = []; this.pendingIndex = undefined; this.reportPreview = ''; this.providers.clearAccess();
  }
}
