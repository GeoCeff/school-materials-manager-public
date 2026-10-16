import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import promises from 'node:fs/promises';
import { mkdtemp, mkdir, open, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { CollectionError, CollectionService, collectionFileLimit, collectionName, collectionURL } from '../src/core/collection.js';
import type { CollectionItem } from '../src/core/collection-model.js';
import { ArchiveService } from '../src/core/index.js';

async function fixture() { const work = await mkdtemp(join(tmpdir(), 'archive-collect-')); const root = join(work, 'archive'); const data = join(work, 'data'); const source = join(work, 'sources'); await mkdir(root); await mkdir(source); return { work, root, data, source }; }
const options = { year: '2026-2027', semester: 'First Semester', school: 'manual' as const, course: 'CMSC 123' };
function note(title = 'Local learning material'): CollectionItem { return { id: randomUUID(), key: 'resource-one', courseId: '123', course: 'CMSC 123', title, kind: 'note', bucket: '01 Lessons and Study Guides', extension: '.md', revision: '1', sourceURL: 'https://classroom.google.com/c/123', size: null, text: 'Lunar telescope lecture instructions.', state: 'ready' }; }

test('storage faults enforce exact free-space reserves and remove failed archive staging', async context => {
  const f = await fixture(); const collector = new CollectionService(f.data, async () => { throw new Error('Unexpected download'); });
  const originalStatfs = promises.statfs; const originalOpen = promises.open;
  const storage = await originalStatfs(f.root); let free = 0; let calls = 0; let fault = ''; let dropAtRun = false;
  const spaceMock = context.mock.method(promises, 'statfs', async () => ({ ...storage, bsize: 1, bavail: dropAtRun && ++calls > 1 ? 0 : free }));
  const openMock = context.mock.method(promises, 'open', async (...args: Parameters<typeof promises.open>) => {
    const file = await originalOpen(...args);
    if (fault && String(args[0]).endsWith('.part')) context.mock.method(file, 'writeFile', async () => { throw Object.assign(new Error(`Synthetic ${fault}`), { code: fault }); });
    return file;
  }); syncBuiltinESMExports();
  try {
    await collector.init(); const item = { ...note(), kind: 'file' as const, extension: '.txt', size: null };
    await collector.prepare(f.root, 'google', 'me', 'Synthetic', [item], options);
    free = 512 * 1024 ** 2 + 2 * collectionFileLimit;
    assert.equal((await collector.preflight([item.id])).unknownSizes, 1);
    assert.equal((await collector.preflight([item.id])).estimatedBytes, collectionFileLimit);
    assert.deepEqual((await collector.preflight([item.id])).problems, []);
    free--; await assert.rejects(collector.start([item.id]), /Insufficient free space/); assert.equal(collector.snapshot().job, null);
    for (fault of ['', 'ENOSPC', 'EACCES']) {
      await collector.prepare(f.root, 'manual', 'manual', 'Synthetic', [note()], options); const id = collector.snapshot().plan!.items[0]!.id;
      free = 10 * 1024 ** 3; calls = 0; dropAtRun = !fault;
      await collector.start([id]); await collector.whenIdle();
      assert.equal(collector.snapshot().job!.failed, 1); assert.equal(collector.snapshot().job!.published, 0);
      assert.match(collector.snapshot().plan!.items[0]!.message!, fault ? new RegExp(fault) : /Insufficient free space/);
      assert.deepEqual(await publishedFiles(f.root), []);
      const managed = (await readdir(join(f.root, 'Collected'))).find(name => name.startsWith('manual-'))!;
      assert.deepEqual(await readdir(join(f.root, 'Collected', managed, '.staging')), []);
    }
    fault = ''; dropAtRun = false; await collector.resume(true); await collector.whenIdle(); assert.equal(collector.snapshot().job!.published, 1);
  } finally { spaceMock.mock.restore(); openMock.mock.restore(); syncBuiltinESMExports(); await collector.close(); await rm(f.work, { recursive: true, force: true }); }
});

test('exact collection budgets accept 1000 items and 2 GiB streamed bytes then pause before excess', { timeout: 180_000 }, async () => {
  const f = await fixture(); let downloads = 0; let streamed = 0;
  const collector = new CollectionService(f.data, async item => {
    downloads++; const path = join(f.data, 'downloads', `${randomUUID()}.part`); const file = await open(path, 'wx');
    try { await file.truncate(item.size!); } finally { await file.close(); }
    streamed += item.size!; return path;
  });
  try {
    await collector.init();
    const thousand = Array.from({ length: 1000 }, (_, n) => ({ ...note(), key: `item-${n}` }));
    await collector.prepare(f.root, 'manual', 'manual', 'Synthetic', thousand, options); assert.equal(collector.snapshot().plan!.items.length, 1000);
    await assert.rejects(collector.prepare(f.root, 'manual', 'manual', 'Synthetic', [...thousand, note()], options), /1,000/);
    const sizes = [...Array<number>(20).fill(collectionFileLimit), 48 * 1024 ** 2, 1];
    const items = sizes.map((size, n) => ({ ...note(`Bytes ${n}`), key: `bytes-${n}`, kind: 'file' as const, extension: '.txt', size }));
    await collector.prepare(f.root, 'google', 'me', 'Synthetic', items, options);
    await collector.start(items.map(item => item.id)); await collector.whenIdle();
    const state = collector.snapshot(); assert.equal(state.job!.state, 'paused'); assert.match(state.job!.message, /2 GiB/);
    assert.equal(state.job!.bytes, 2 * 1024 ** 3); assert.equal(streamed, 2 * 1024 ** 3); assert.equal(downloads, 21);
    assert.equal(state.job!.published, 21); assert.equal(state.plan!.items.at(-1)!.state, 'ready');
    assert.equal((await publishedFiles(f.root)).length, 21); assert.deepEqual(await readdir(join(f.data, 'downloads')), []);
    await collector.resume(); await collector.whenIdle(); assert.equal(collector.snapshot().job!.state, 'completed'); assert.equal(collector.snapshot().job!.bytes, 2 * 1024 ** 3 + 1);
    const db = new DatabaseSync(join(f.data, 'collection.sqlite'));
    try {
      const used = Number(db.prepare('SELECT SUM(size) AS bytes FROM collection_versions').get()!.bytes);
      db.prepare('INSERT INTO collection_versions VALUES (?,?,?,?,?,?,?,?)').run(f.root, 'google:me', 'seed', '1', '0'.repeat(64), 'synthetic-budget-receipt.txt', 10 * 1024 ** 3 - used - 1, new Date().toISOString());
    } finally { db.close(); }
    const last = [0, 1].map(n => ({ ...note(`Catalog ${n}`), key: `catalog-${n}`, kind: 'file' as const, extension: '.txt', size: 1 }));
    await collector.prepare(f.root, 'google', 'me', 'Synthetic', last, options); const before = downloads;
    await collector.start(last.map(item => item.id)); await collector.whenIdle();
    assert.equal(collector.snapshot().job!.published, 1); assert.equal(downloads, before + 1);
    assert.equal(collector.snapshot().job!.state, 'paused'); assert.match(collector.snapshot().job!.message, /10 GiB/);
  } finally { await collector.close(); await rm(f.work, { recursive: true, force: true }); }
});

test('collection run deadline accepts exactly 30 minutes and pauses one millisecond later', async context => {
  const f = await fixture(); let collector!: CollectionService; const now = Date.now; let elapsed = 0; let clock = now();
  const timeMock = context.mock.method(Date, 'now', () => clock);
  collector = new CollectionService(f.data, async () => { throw new Error('Unexpected download'); }, () => {
    const job = collector.progress(); if (job?.current) clock = Date.parse(job.started) + elapsed;
  });
  try {
    await collector.init();
    for (elapsed of [30 * 60_000, 30 * 60_000 + 1]) {
      clock = now(); const items = [note('First'), { ...note('Second'), key: 'second' }];
      await collector.prepare(f.root, 'manual', 'manual', 'Synthetic', items, options); await collector.start(items.map(item => item.id)); await collector.whenIdle();
      assert.equal(collector.snapshot().job!.state, elapsed === 30 * 60_000 ? 'completed' : 'paused');
      if (elapsed > 30 * 60_000) { assert.match(collector.snapshot().job!.message, /Run time limit/); assert.equal(collector.snapshot().plan!.items[1]!.state, 'ready'); }
    }
  } finally { timeMock.mock.restore(); await collector.close(); await rm(f.work, { recursive: true, force: true }); }
});

test('index refresh search and preview stay usable while a collection transfer is pending', async () => {
  const f = await fixture(); const archive = new ArchiveService(join(f.work, 'index'));
  let entered!: () => void; let release!: () => void; const started = new Promise<void>(resolve => { entered = resolve; }); const held = new Promise<void>(resolve => { release = resolve; });
  const collector = new CollectionService(f.data, async () => { entered(); await held; const path = join(f.data, 'downloads', `${randomUUID()}.part`); await writeFile(path, 'collectedneedle'); return path; });
  try {
    await writeFile(join(f.root, 'original.txt'), 'originalneedle'); await archive.init(); await archive.prepareRoot(f.root); await archive.start('import'); await archive.whenIdle(); await collector.init();
    const item = { ...note(), kind: 'file' as const, extension: '.txt', size: 15 };
    await collector.prepare(f.root, 'google', 'me', 'Synthetic', [item], options); await collector.start([item.id]); await started;
    const jobs = await Promise.all([archive.start('refresh'), archive.start('refresh')]); assert.equal(jobs[0]!.id, jobs[1]!.id); await archive.whenIdle();
    const hit = archive.search('originalneedle', {}, 0).results[0]!; assert.match((await archive.preview(hit.fileId, hit.passageId)).text, /originalneedle/);
    assert.equal(archive.search('collectedneedle', {}, 0).total, 0); release(); await collector.whenIdle();
    assert.equal(collector.snapshot().job!.state, 'completed'); await archive.start('refresh'); await archive.whenIdle();
    assert.equal(archive.search('collectedneedle', {}, 0).total, 1); assert.equal(archive.search('originalneedle', {}, 0).total, 1);
  } finally { release?.(); await collector.close(); await archive.close(); await rm(f.work, { recursive: true, force: true }); }
});
async function publishedFiles(root: string): Promise<string[]> { const result: string[] = []; async function visit(path: string) { for (const entry of await readdir(path, { withFileTypes: true })) { if (entry.name.startsWith('.')) continue; const next = join(path, entry.name); if (entry.isDirectory()) await visit(next); else result.push(next); } } await visit(root); return result; }

test('collection publishes verified copies without changing originals and feeds the existing indexer', async () => {
  const f = await fixture(); const source = join(f.source, 'lecture.txt'); await writeFile(source, 'orbital learning material'); await writeFile(join(f.root, 'original.txt'), 'existing original');
  const collector = new CollectionService(f.data, async () => { throw new Error('Unexpected network'); }); const archive = new ArchiveService(join(f.work,'index'));
  try {
    await collector.init(); await collector.prepareLocal(f.root, [source], options); const plan = collector.snapshot().plan!;
    assert.equal(plan.items.length, 1); assert.equal(plan.items[0]!.localPath, undefined);
    await collector.start(plan.items.map(item => item.id)); await collector.whenIdle();
    assert.equal(collector.snapshot().job!.state, 'completed'); const files = await publishedFiles(f.root); assert.equal(files.length,2);
    assert.equal(await readFile(source,'utf8'), 'orbital learning material'); assert.equal(await readFile(join(f.root,'original.txt'),'utf8'), 'existing original');
    await archive.init(); await archive.prepareRoot(f.root); await archive.start('import'); await archive.whenIdle();
    assert.equal(archive.search('orbital',{},0).total,1); assert.ok(archive.search('orbital',{},0).results[0]!.relativePath.startsWith('Collected'));
    if (process.platform === 'win32') assert.match(await readFile(`${files.find(path => path.endsWith('.txt') && !path.endsWith('original.txt'))}:Zone.Identifier`,'utf8'), /ZoneId=3/);
  } finally { await archive.close(); await collector.close(); await rm(f.work,{recursive:true,force:true}); }
});

test('collection versioning preserves user edits and rejects source changes after review', async () => {
  const f = await fixture(); const path = join(f.source,'notes.txt'); await writeFile(path,'first version'); const collector = new CollectionService(f.data, async () => { throw new Error('Unexpected network'); });
  try {
    await collector.init(); await collector.prepareLocal(f.root,[path],options); await collector.start(collector.snapshot().plan!.items.map(item => item.id)); await collector.whenIdle();
    const imported = (await publishedFiles(f.root))[0]!; await writeFile(imported,'my edited copy');
    await writeFile(path,'second version: new concepts'); await collector.prepareLocal(f.root,[path],options); await collector.start(collector.snapshot().plan!.items.map(item => item.id)); await collector.whenIdle();
    assert.equal((await publishedFiles(f.root)).length,2); assert.equal(await readFile(imported,'utf8'),'my edited copy');
    await collector.prepareLocal(f.root,[path],options); await writeFile(path,'changed after the user reviewed the file');
    await collector.start(collector.snapshot().plan!.items.map(item => item.id)); await collector.whenIdle(); assert.equal(collector.snapshot().job!.failed,1); assert.match(collector.snapshot().plan!.items[0]!.message!,/changed after review/);
  } finally { await collector.close(); await rm(f.work,{recursive:true,force:true}); }
});

test('safe names, links and item selection reject trust-boundary violations', async () => {
  assert.equal(collectionName('CON'),'_CON'); assert.equal(collectionName('../../bad:file\u202e.exe'), '_.._bad_file_.exe'); assert.equal(collectionName('tail. '),'tail');
  assert.equal(collectionURL('http://localhost/secret'),''); assert.equal(collectionURL('https://evil.example/file?token=secret'),'');
  assert.equal(collectionURL('https://drive.google.com/file/d/123/view?resourcekey=secret#token'),'https://drive.google.com/file/d/123/view');
  assert.equal(collectionURL('https://uvec.upcebu.edu.ph/course/view.php?id=123&token=secret'),'https://uvec.upcebu.edu.ph/course/view.php?id=123');
  const f = await fixture(); const collector = new CollectionService(f.data,async () => { throw new Error('Unexpected network'); });
  try {
    await collector.init(); await collector.prepare(f.root,'google','me','Student',[note()],options);
    await assert.rejects(collector.start([randomUUID()]),/current review/); const id = collector.snapshot().plan!.items[0]!.id;
    await assert.rejects(collector.start([id,id]),/current review/);
    const outside = join(f.work,'outside'); await mkdir(outside); await symlink(outside,join(f.root,'Collected'),process.platform === 'win32' ? 'junction' : 'dir');
    await collector.start([id]); await collector.whenIdle(); assert.equal(collector.snapshot().job!.state,'paused'); assert.equal((await readdir(outside)).length,0);
  } finally { await collector.close(); await rm(f.work,{recursive:true,force:true}); }
});

test('pause, restart and resume preserve complete work and never publish a partial download', async () => {
  const f = await fixture(); await mkdir(join(f.data,'downloads'),{recursive:true}); let began!: () => void; const started = new Promise<void>(resolve => { began = resolve; });
  let collector = new CollectionService(f.data,async (_item,signal) => new Promise<string>((_resolve,reject) => { began(); signal.addEventListener('abort',() => reject(new Error('Cancelled')), {once:true}); }));
  const item = { ...note(), kind: 'file' as const, fileId: 'safe-id', extension: '.txt', text: undefined, size: 14 };
  try {
    await collector.init(); await collector.prepare(f.root,'google','me','Student',[item],options); await collector.start([item.id]); await started; collector.stop('pause'); await collector.whenIdle();
    assert.equal(collector.snapshot().job!.state,'paused'); assert.equal((await publishedFiles(f.root)).length,0); await collector.close();
    collector = new CollectionService(f.data,async () => { const path = join(f.data,'downloads',`${randomUUID()}.part`); await writeFile(path,'complete bytes'); return path; });
    await collector.init(); await collector.resume(); await collector.whenIdle(); assert.equal(collector.snapshot().job!.state,'completed'); assert.equal(collector.snapshot().job!.processed,1);
    assert.equal(await readFile((await publishedFiles(f.root))[0]!,'utf8'),'complete bytes');
  } finally { await collector.close(); await rm(f.work,{recursive:true,force:true}); }
});

test('durable receipts recover a published file after a crash without another provider download', async () => {
  const f = await fixture(); let downloads = 0;
  let collector = new CollectionService(f.data,async () => { downloads++; throw new Error('Must not download a published receipt'); });
  try {
    await collector.init(); const item = note(); await collector.prepare(f.root,'google','me','Student',[item],options); await collector.start([item.id]); await collector.whenIdle();
    const snapshot = collector.snapshot(); const path = snapshot.plan!.items[0]!.path!; const bytes = await readFile(join(f.root,path)); await collector.close();
    const db = new DatabaseSync(join(f.data,'collection.sqlite'));
    const storedItem = JSON.parse((db.prepare('SELECT value FROM collection_items WHERE id=?').get(item.id) as {value:string}).value); storedItem.state = 'ready'; delete storedItem.path;
    db.prepare('UPDATE collection_items SET value=? WHERE id=?').run(JSON.stringify(storedItem),item.id); db.exec('DELETE FROM collection_versions');
    const job = { ...snapshot.job!, state: 'running', processed:0, published:0, bytes:0 };
    db.prepare('UPDATE collection_state SET value=? WHERE key=?').run(JSON.stringify(job),'job');
    db.prepare('INSERT OR REPLACE INTO collection_state VALUES (?,?)').run(`receipt:${snapshot.plan!.id}:${item.id}`,JSON.stringify({path,hash:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length})); db.close();
    collector = new CollectionService(f.data,async () => { downloads++; throw new Error('Unexpected retry'); }); await collector.init(); assert.equal(collector.snapshot().job!.state,'interrupted');
    await collector.resume(); await collector.whenIdle(); assert.equal(collector.snapshot().job!.state,'completed'); assert.equal(downloads,0); assert.equal((await publishedFiles(f.root)).length,1);
  } finally { await collector.close(); await rm(f.work,{recursive:true,force:true}); }
});

test('unchanged remote resources reuse verified files and catalog survives index rebuilds', async () => {
  const f = await fixture(); const collector = new CollectionService(f.data,async () => { throw new Error('Unexpected network'); });
  try {
    await collector.init(); const first = note(); await collector.prepare(f.root,'google','me','Student',[first],options); await collector.start([first.id]); await collector.whenIdle();
    const second = note(); await collector.prepare(f.root,'google','me','Student',[second],options); await collector.start([second.id]); await collector.whenIdle();
    assert.equal(collector.snapshot().job!.unchanged,1); assert.equal((await publishedFiles(f.root)).length,1); assert.equal(collector.snapshot().plan!.items[0]!.text,undefined);
    const archive = new ArchiveService(join(f.work,'index')); await archive.init(); await archive.prepareRoot(f.root); await archive.start('import'); await archive.whenIdle(); await archive.start('rebuild'); await archive.whenIdle(); await archive.close();
    assert.equal(collector.snapshot().plan!.items[0]!.sourceURL,'https://classroom.google.com/c/123');
  } finally { await collector.close(); await rm(f.work,{recursive:true,force:true}); }
});

test('unapproved download receipts and executable local files cannot become collected copies', async () => {
  const f = await fixture(); const outside = join(f.source,'outside.txt'); await writeFile(outside,'private file'); const executable = join(f.source,'app.exe'); await writeFile(executable,'not permitted');
  const collector = new CollectionService(f.data,async () => outside);
  try {
    await collector.init(); await assert.rejects(collector.prepareLocal(f.root,[executable],options),/No materials/);
    const item = { ...note(), kind:'file' as const, extension:'.txt', fileId:'id', size:12 }; await collector.prepare(f.root,'google','me','Student',[item],options); await collector.start([item.id]); await collector.whenIdle();
    assert.equal(collector.snapshot().job!.failed,1); assert.equal(await readFile(outside,'utf8'),'private file'); assert.equal((await publishedFiles(f.root)).length,0);
  } finally { await collector.close(); await rm(f.work,{recursive:true,force:true}); }
});

test('oversized review metadata and future catalogs fail closed without losing the previous review', async () => {
  const f=await fixture(); const collector=new CollectionService(f.data,async()=>{throw new Error('Unexpected network');});
  try{
    await collector.init();const original=note();await collector.prepare(f.root,'google','me','Student',[original],options);
    await assert.rejects(collector.prepare(f.root,'google','me','Student',[{...note(),size:-1}],options),/Invalid material/);
    await assert.rejects(collector.prepare(f.root,'google','me','Student',Array.from({length:34},()=>({...note(),text:'x'.repeat(249_000)})),options),/8 MiB/);
    assert.equal(collector.snapshot().plan!.items[0]!.id,original.id);await collector.close();
    const db=new DatabaseSync(join(f.data,'collection.sqlite'));db.exec('PRAGMA user_version=3');db.close();
    const before=await readFile(join(f.data,'collection.sqlite'));const future=new CollectionService(f.data,async()=>{throw new Error('Unexpected network');});
    try{await assert.rejects(future.init(),/newer application/);}finally{await future.close();}
    assert.deepEqual(await readFile(join(f.data,'collection.sqlite')),before);
  }finally{await collector.close();await rm(f.work,{recursive:true,force:true});}
});

test('shared attachments keep independent course and semester destinations without downloading twice', async()=>{
  const f=await fixture();let downloads=0;const collector=new CollectionService(f.data,async()=>{downloads++;const path=join(f.data,'downloads',`${randomUUID()}.part`);await writeFile(path,'shared lecture');return path;});
  try{
    await collector.init();const a={...note(),kind:'file' as const,extension:'.txt',text:undefined,size:14};const b={...a,id:randomUUID(),courseId:'124',course:'CMSC 124'};
    await collector.prepare(f.root,'google','me','Student',[a,b],options);await collector.start([a.id,b.id]);await collector.whenIdle();
    const paths=collector.snapshot().plan!.items.map(item=>item.path!);assert.equal(downloads,1);assert.notEqual(paths[0],paths[1]);assert.match(paths[1]!,/CMSC 124/);
    await writeFile(join(f.root,paths[0]!),'my independent edit');assert.equal(await readFile(join(f.root,paths[1]!),'utf8'),'shared lecture');
    const next={...b,id:randomUUID()};await collector.prepare(f.root,'google','me','Student',[next],options);
    await collector.organize([{courseId:'124',year:'2027-2028',semester:'Second Semester',subject:'CMSC 124'}]);await collector.start([next.id]);await collector.whenIdle();
    assert.equal(downloads,1);assert.match(collector.snapshot().plan!.items[0]!.path!,/2027-2028.*Second Semester/);
    await collector.prepare(f.root,'google','me','Student',[{...next,id:randomUUID()}],options);assert.equal(collector.snapshot().plan!.mappings![0]!.year,'2027-2028');
  }finally{await collector.close();await rm(f.work,{recursive:true,force:true});}
});

test('catalog failure after publication pauses with truthful counters and recovers the receipt',async()=>{
  const f=await fixture();let downloads=0;const collector=new CollectionService(f.data,async()=>{downloads++;const path=join(f.data,'downloads',`${randomUUID()}.part`);await writeFile(path,'hello');return path;});
  try{
    await collector.init();const item={...note(),kind:'file' as const,extension:'.txt',text:undefined,size:5};await collector.prepare(f.root,'google','me','Student',[item],options);
    const db=(collector as unknown as {db:DatabaseSync}).db;
    db.exec("CREATE TRIGGER reject_published BEFORE INSERT ON collection_items WHEN json_extract(NEW.value,'$.state')='published' BEGIN SELECT RAISE(FAIL,'synthetic write failure'); END;");
    await collector.start([item.id]);await collector.whenIdle();const failed=collector.snapshot().job!;
    assert.equal(failed.state,'paused');assert.equal(failed.processed,0);assert.equal(failed.published,0);assert.equal(failed.failed,0);assert.equal((await publishedFiles(f.root)).length,1);
    db.exec('DROP TRIGGER reject_published');await collector.resume();await collector.whenIdle();assert.equal(downloads,1);assert.equal(collector.snapshot().job!.processed,1);assert.equal(collector.snapshot().job!.published,1);
  }finally{await collector.close();await rm(f.work,{recursive:true,force:true});}
});

test('retry failed retains completed items and preflight blocks invalid destinations before transport',async()=>{
  const f=await fixture();let failing=true;let downloads=0;const collector=new CollectionService(f.data,async()=>{downloads++;if(failing)throw new CollectionError('Synthetic offline failure','temporary');const path=join(f.data,'downloads',`${randomUUID()}.part`);await writeFile(path,'hello');return path;});
  try{
    await collector.init();const ready=note();const remote={...note('Attachment'),id:randomUUID(),key:'attachment',kind:'file' as const,extension:'.txt',text:undefined,size:5};
    await collector.prepare(f.root,'google','me','Student',[ready,remote],options);await collector.start([ready.id,remote.id]);await collector.whenIdle();assert.equal(collector.snapshot().job!.failed,1);
    failing=false;await collector.resume(true,true);await collector.whenIdle();const done=collector.snapshot().job!;assert.equal(done.processed,2);assert.equal(done.published,2);assert.equal(done.failed,0);assert.equal(downloads,2);
    await collector.organize([{courseId:'123',year:'x'.repeat(70),semester:'s'.repeat(70),subject:'z'.repeat(70)}]);
    assert.match((await collector.preflight([remote.id])).problems[0]!,/240/);await assert.rejects(collector.start([remote.id]),/240/);assert.equal(downloads,2);
  }finally{await collector.close();await rm(f.work,{recursive:true,force:true});}
});

test('version-one catalogs migrate without dropping existing receipts',async()=>{
  const f=await fixture();await mkdir(f.data);const db=new DatabaseSync(join(f.data,'collection.sqlite'));
  db.exec('CREATE TABLE collection_versions (root TEXT NOT NULL, account TEXT NOT NULL, resource TEXT NOT NULL, revision TEXT NOT NULL, hash TEXT NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL, acquired TEXT NOT NULL, PRIMARY KEY(root,account,resource,revision,hash)); PRAGMA user_version=1;');
  db.prepare('INSERT INTO collection_versions VALUES (?,?,?,?,?,?,?,?)').run(f.root,'google:me','one','1','hash','path',5,'date');db.close();
  const collector=new CollectionService(f.data,async()=>{throw new Error('Unexpected network');});
  try{await collector.init();const migrated=(collector as unknown as {db:DatabaseSync}).db;assert.equal(migrated.prepare('PRAGMA user_version').get()!.user_version,2);assert.equal(migrated.prepare('SELECT COUNT(*) AS count FROM collection_versions').get()!.count,1);}
  finally{await collector.close();await rm(f.work,{recursive:true,force:true});}
});

test('local review detects changed bytes even when size and modified time are preserved, and missing files publish nothing',async()=>{
  const f=await fixture();const path=join(f.source,'notes.txt');const collector=new CollectionService(f.data,async()=>{throw new Error('Unexpected network');});
  try{
    await collector.init();await writeFile(path,'first bytes');const fixed=new Date('2026-01-01T00:00:00Z');await utimes(path,fixed,fixed);
    await collector.prepareLocal(f.root,[path],options);await writeFile(path,'other bytes');await utimes(path,fixed,fixed);
    await collector.start(collector.snapshot().plan!.items.map(item=>item.id));await collector.whenIdle();
    assert.equal(collector.snapshot().job!.failed,1);assert.equal(collector.snapshot().plan!.items[0]!.failure,'changed');assert.deepEqual(await publishedFiles(f.root),[]);
    await collector.prepareLocal(f.root,[path],options);await rm(path);await collector.start(collector.snapshot().plan!.items.map(item=>item.id));await collector.whenIdle();
    assert.equal(collector.snapshot().job!.failed,1);assert.deepEqual(await publishedFiles(f.root),[]);
  }finally{await collector.close();await rm(f.work,{recursive:true,force:true});}
});

test('empty reviews preserve the previous plan and mappings and preflight follow the current account and selection',async()=>{
  const f=await fixture();const collector=new CollectionService(f.data,async()=>{throw new Error('Unexpected network');});
  try{
    await collector.init();const a=note();const b={...note('Other'),id:randomUUID(),key:'other'};
    await collector.prepare(f.root,'google','account-one','Student',[a,b],options);const original=collector.snapshot().plan!.id;
    await assert.rejects(collector.prepareLocal(f.root,[],options),/No materials/);assert.equal(collector.snapshot().plan!.id,original);
    await collector.organize([{courseId:a.courseId,year:'2027',semester:'Second',subject:'CMSC 124'}]);assert.match((await collector.preflight([a.id])).items[0]!.path,/2027.*Second.*CMSC 124/);
    await collector.start([b.id]);await collector.whenIdle();assert.equal(collector.snapshot().plan!.items[0]!.state,'excluded');assert.equal(collector.snapshot().job!.total,1);
    await collector.prepare(f.root,'google','account-two','Other student',[{...note(),id:randomUUID()}],options);assert.equal(collector.snapshot().plan!.mappings![0]!.year,options.year);
    await assert.rejects(collector.start([a.id]),/current review/);
    await collector.prepare(f.root,'google','account-two','Other student',[{...note(),kind:'file',extension:'.txt',text:undefined,size:null}],options);
    const preflight=await collector.preflight(collector.snapshot().plan!.items.map(item=>item.id));assert.equal(preflight.unknownSizes,1);assert.equal(preflight.estimatedBytes,100*1024**2);
  }finally{await collector.close();await rm(f.work,{recursive:true,force:true});}
});

test('changed managed ownership prevents publication and catalog byte budgets stop before downloads',async()=>{
  const f=await fixture();let downloads=0;let collector:CollectionService;
  collector=new CollectionService(f.data,async()=>{downloads++;const directories=await readdir(join(f.root,'Collected'));const owner=join(f.root,'Collected',directories[0]!,'.archive-search-owner');await writeFile(owner,'changed owner');const path=join(f.data,'downloads',`${randomUUID()}.part`);await writeFile(path,'hello');return path;});
  try{
    await collector.init();const item={...note(),kind:'file' as const,extension:'.txt',text:undefined,size:5};await collector.prepare(f.root,'google','me','Student',[item],options);await collector.start([item.id]);await collector.whenIdle();
    assert.equal(collector.snapshot().job!.failed,1);assert.match(collector.snapshot().plan!.items[0]!.message!,/ownership changed/);assert.deepEqual(await publishedFiles(f.root),[]);
    const db=(collector as unknown as {db:DatabaseSync}).db;const owner=db.prepare('SELECT id FROM collection_destinations').get() as {id:string};await writeFile(join(f.root,'Collected',`google-${owner.id.slice(0,8)}`,'.archive-search-owner'),owner.id);
    db.prepare('INSERT INTO collection_versions VALUES (?,?,?,?,?,?,?,?)').run(f.root,'google:other','large','1','synthetic','missing-retained-copy',10*1024**3,'date');
    await collector.prepare(f.root,'google','me','Student',[{...item,id:randomUUID()}],options);await collector.start(collector.snapshot().plan!.items.map(item=>item.id));await collector.whenIdle();assert.equal(collector.snapshot().job!.state,'paused');assert.match(collector.snapshot().job!.message,/10 GiB/);assert.equal(downloads,1);
    await assert.rejects(collector.prepare(f.root,'google','me','Student',Array.from({length:1001},()=>({...note(),id:randomUUID()})),options),/1,000/);
  }finally{await collector.close();await rm(f.work,{recursive:true,force:true});}
});

test('pause cancellation and closing active transfers retain distinct restart outcomes without publishing partials',async()=>{
  for(const action of ['pause','cancel','close'] as const){
    const f=await fixture();let began!:()=>void;const started=new Promise<void>(resolve=>{began=resolve;});
    let collector=new CollectionService(f.data,async(_item,signal)=>new Promise((_resolve,reject)=>{began();signal.addEventListener('abort',()=>reject(new Error('Synthetic stopped transfer')),{once:true});}));
    try{
      await collector.init();const item={...note(),kind:'file' as const,extension:'.txt',text:undefined,size:5};await collector.prepare(f.root,'google','me','Student',[item],options);await collector.start([item.id]);await started;
      if(action==='close')await collector.close();else{collector.stop(action);await collector.whenIdle();await collector.close();}
      collector=new CollectionService(f.data,async()=>{throw new Error('No automatic restart transfer allowed');});await collector.init();
      assert.equal(collector.snapshot().job!.state,action==='cancel'?'cancelled':'paused');assert.deepEqual(await publishedFiles(f.root),[]);
      if(action==='cancel')await assert.rejects(collector.resume(),/no collection to resume/);
    }finally{await collector.close();await rm(f.work,{recursive:true,force:true});}
  }
});

test('manual review cancellation aborts hashing and aggregate limits reject before hashing or replacing the previous plan',async()=>{
  const f=await fixture();const collector=new CollectionService(f.data,async()=>{throw new Error('No network');});const createReadStream=fs.createReadStream;
  try{
    await collector.init();await collector.prepare(f.root,'google','me','Student',[note()],options);const previous=collector.snapshot().plan!.id;
    const path=join(f.source,'large.txt');await writeFile(path,Buffer.alloc(16*1024**2));let started!:()=>void;const hashing=new Promise<void>(resolve=>{started=resolve;});let reads=0;
    fs.createReadStream=((...args:Parameters<typeof createReadStream>)=>{reads++;const stream=createReadStream(...args);started();return stream;}) as typeof createReadStream;syncBuiltinESMExports();
    const review=collector.prepareLocal(f.root,[path],options);await hashing;collector.stop('cancel');await assert.rejects(review,{name:'AbortError'});await collector.whenIdle();assert.equal(collector.snapshot().plan!.id,previous);assert.equal(reads,1);
    const file=await open(path,'r+');try{await file.truncate(100*1024**2);}finally{await file.close();}
    await assert.rejects(collector.prepareLocal(f.root,Array(21).fill(path),options),/at most 2 GiB/);assert.equal(reads,1);assert.equal(collector.snapshot().plan!.id,previous);
    await assert.rejects(collector.prepareLocal(f.root,Array(1001).fill(path),options),/1,000/);assert.equal(reads,1);assert.deepEqual(await publishedFiles(f.root),[]);
  }finally{fs.createReadStream=createReadStream;syncBuiltinESMExports();await collector.close();await rm(f.work,{recursive:true,force:true});}
});
