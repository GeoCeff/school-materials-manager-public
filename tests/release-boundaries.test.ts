import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { crc32, deflateRawSync } from 'node:zlib';
import { archiveRelative } from '../src/core/paths.js';
import { extract, extractBounded, previewPdf } from '../src/core/extract.js';
import { Library } from '../src/core/library.js';
import { ArchiveService } from '../src/core/index.js';
import type { Job } from '../src/core/model.js';
import { syntheticDocx, syntheticZip } from '../src/office-fixtures.js';
import { syntheticPdf } from '../src/smoke.js';
import { nativeEnvironment, windowsTask } from '../src/core/windows.js';

test('archive paths reject Windows aliases, device names, invalid characters and escapes', () => {
  for (const path of ['../x.txt', 'a/../x.txt', 'C:/x.txt', '//server/share/x.txt', '\\\\?\\C:\\x.txt', 'x\0.txt', 'a:stream.txt',
    '.secret/x.txt', 'NODE_MODULES/x.txt', 'x.txt.', 'x.txt ', 'folder./x.txt', 'CON', 'con.txt', 'COM1.txt', 'LPT9.txt', 'COM¹.txt', 'NUL.txt', 'bad?.txt', 'a//b.txt', 'x'.repeat(32769)]) {
    assert.throws(() => archiveRelative(path), /outside-root|excluded-path/, path);
  }
  assert.equal(archiveRelative('Course\\Week 1/日本語.txt'), 'Course/Week 1/日本語.txt');
  assert.equal(archiveRelative('console.txt'), 'console.txt');
});

test('physical line locators survive blank lines, CRLF, Unicode and split long lines', async () => {
  const work = await mkdtemp(join(tmpdir(), 'archive-release-lines-'));
  try {
    for (const newline of ['\r\n', '\n']) {
      const path = join(work, 'lines.txt');
      await writeFile(path, ['first', '', '日本語 café', 'x'.repeat(8001), 'last'].join(newline));
      const result = await extract(path);
      assert.equal(result.passages[0]!.startLine, 1); assert.equal(result.passages[0]!.endLine, 3);
      assert.equal(result.passages[0]!.text, 'first\n\n日本語 café');
      assert.deepEqual(result.passages.slice(1, 4).map(p => [p.startLine, p.endLine, p.text.length]), [[4, 4, 4000], [4, 4, 4000], [4, 4, 1]]);
      assert.equal(result.passages[4]!.startLine, 5); assert.equal(result.passages[4]!.text, 'last');
    }
  } finally { await rm(work, { recursive: true, force: true }); }
});

test('text byte, total character and passage limits hold at exact boundaries', async () => {
  const work = await mkdtemp(join(tmpdir(), 'archive-release-text-limits-')); const path = join(work, 'text.txt');
  try {
    await writeFile(path, 'a'.repeat(2_000_000)); const exact = await extract(path);
    assert.equal(exact.passages.length, 500); assert.ok(exact.passages.every(p => p.text.length === 4000));
    await writeFile(path, 'a'.repeat(2_000_001)); await assert.rejects(extract(path), /text-limit/);
    await writeFile(path, Buffer.concat([Buffer.from('é'.repeat(1024 * 1024 - 1)), Buffer.from('aa')]));
    assert.equal((await stat(path)).size, 2 * 1024 * 1024); assert.equal((await extract(path)).status, 'indexed');
    await writeFile(path, Buffer.alloc(2 * 1024 * 1024 + 1, 65)); await assert.rejects(extract(path), /size-limit/);
  } finally { await rm(work, { recursive: true, force: true }); }
});

test('malformed and encrypted Office containers remain per-file failures; legacy formats stay unsupported', async () => {
  const work = await mkdtemp(join(tmpdir(), 'archive-release-office-errors-')); const root = join(work, 'archive'); await mkdir(root);
  const library = await Library.open(root, join(work, 'index.sqlite'));
  try {
    await writeFile(join(root, 'good.txt'), 'survivingneedle'); await library.indexFile('good.txt');
    const good = syntheticDocx(['valid fixture']); const encrypted = syntheticZip({ 'word/document.xml': '\0'.repeat(12) + 'encrypted payload' });
    for (let i = 0; i < encrypted.length - 4; i++) {
      if (encrypted.readUInt32LE(i) === 0x04034b50) encrypted.writeUInt16LE(encrypted.readUInt16LE(i + 6) | 1, i + 6);
      if (encrypted.readUInt32LE(i) === 0x02014b50) encrypted.writeUInt16LE(encrypted.readUInt16LE(i + 8) | 1, i + 8);
    }
    for (const [name, bytes] of [['malformed.docx', Buffer.from('not zip')], ['truncated.docx', good.subarray(0, good.length - 30)], ['encrypted.docx', encrypted]] as const) {
      await writeFile(join(root, name), bytes); assert.equal((await library.indexFile(name)).error, 'invalid-office');
    }
    for (const extension of ['doc', 'ppt', 'docm', 'pptm', 'xlsx', 'xlsm', 'zip', '7z']) {
      const path = join(root, `macro.${extension}`); await writeFile(path, good); await assert.rejects(extractBounded(path), /unsupported-type/);
    }
    assert.equal(library.search('survivingneedle').length, 1); library.validate();
  } finally { library.close(); await rm(work, { recursive: true, force: true }); }
});

test('Office DTDs and external slide relationships cannot read files or fetch a URL', async () => {
  const work = await mkdtemp(join(tmpdir(), 'archive-release-office-external-')); let requests = 0;
  const server = createServer((_request, response) => { requests++; response.end('external-secret'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number }; const url = `http://127.0.0.1:${address.port}/external.xml`;
  try {
    const secret = join(work, 'secret.txt'); await writeFile(secret, 'neverexpose');
    for (const target of [url, new URL(`file:///${secret.replaceAll('\\', '/')}`).href]) {
      const path = join(work, 'unsafe.docx'); await writeFile(path, syntheticZip({ 'word/document.xml': `<!DOCTYPE document [<!ENTITY leak SYSTEM "${target}">]><document><body><p><t>&leak;</t></p></body></document>` }));
      await assert.rejects(extractBounded(path), /invalid-office/);
    }
    for (const target of [url, '../secret.xml', '/absolute.xml', 'C:/secret.xml']) {
      const path = join(work, 'unsafe.pptx'); await writeFile(path, syntheticZip({
        'ppt/presentation.xml': '<presentation xmlns:r="urn:test"><sldIdLst><sldId r:id="rId1"/></sldIdLst></presentation>',
        'ppt/_rels/presentation.xml.rels': `<Relationships><Relationship Id="rId1" TargetMode="External" Target="${target}"/></Relationships>`,
      }));
      await assert.rejects(extractBounded(path), /invalid-office/);
    }
    assert.equal(requests, 0); assert.equal(await readFile(secret, 'utf8'), 'neverexpose');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(work, { recursive: true, force: true }); }
});

test('Office declarations, XML limits and ZIP entry limits reject bounded malicious fixtures', { timeout: 90_000 }, async () => {
  const work = await mkdtemp(join(tmpdir(), 'archive-release-office-limits-')); const path = join(work, 'limit.docx');
  try {
    const valid = '<document><body><p><t>safe</t></p></body></document>';
    await writeFile(path, syntheticZip({ 'word/document.xml': valid, ...Object.fromEntries(Array.from({ length: 4999 }, (_, n) => [`part${n}`, ''])) }));
    assert.equal((await extractBounded(path)).status, 'indexed');
    await writeFile(path, syntheticZip({ 'word/document.xml': valid, ...Object.fromEntries(Array.from({ length: 5000 }, (_, n) => [`part${n}`, ''])) }));
    await assert.rejects(extractBounded(path), /office-limit/);
    const declaration = syntheticDocx(['safe']);
    const central = declaration.indexOf(Buffer.from('504b0102', 'hex')); declaration.writeUInt32LE(16_777_217, central + 24);
    await writeFile(path, declaration); await assert.rejects(extractBounded(path), /office-limit/);
    const aggregate = syntheticZip({ 'word/document.xml': valid, a: '', b: '', c: '', d: '' }); let entry = aggregate.indexOf(Buffer.from('504b0102', 'hex'));
    while (entry >= 0) {
      const length = aggregate.readUInt16LE(entry + 28);
      if (length === 1) aggregate.writeUInt32LE(16_777_216, entry + 24);
      entry = aggregate.indexOf(Buffer.from('504b0102', 'hex'), entry + 46 + length);
    }
    await writeFile(path, aggregate); await assert.rejects(extractBounded(path), /office-limit/);
    const compressed = (expanded: string, declared = Buffer.byteLength(expanded)) => {
      const name = Buffer.from('word/document.xml'); const bytes = Buffer.from(expanded); const packed = deflateRawSync(bytes);
      const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
      local.writeUInt32LE(crc32(bytes), 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(declared, 22); local.writeUInt16LE(name.length, 26);
      const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
      central.writeUInt32LE(crc32(bytes), 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(declared, 24); central.writeUInt16LE(name.length, 28);
      const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
      end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + packed.length, 16);
      return Buffer.concat([local, name, packed, central, name, end]);
    };
    const bomb = compressed('x'.repeat(16_777_217)); assert.ok(bomb.length < 20_000);
    await writeFile(path, bomb); await assert.rejects(extractBounded(path), /office-limit/);
    await writeFile(path, compressed(`<document><body><p><t>${'x'.repeat(8_388_609)}</t></p></body></document>`, 1));
    await assert.rejects(extractBounded(path), /invalid-office/);
    await writeFile(path, syntheticZip({ 'word/document.xml': `<document><body><p><t>${'x'.repeat(8_388_609)}</t></p></body></document>` }));
    await assert.rejects(extractBounded(path), /invalid-office/);
    await writeFile(path, syntheticDocx(['x'.repeat(2_000_000)])); assert.equal((await extractBounded(path)).passages.length, 500);
    await writeFile(path, syntheticDocx(['x'.repeat(2_000_001)])); await assert.rejects(extractBounded(path), /office-limit/);
  } finally { await rm(work, { recursive: true, force: true }); }
});

test('source replacement during extraction retains only the previous searchable bytes', async () => {
  const work = await mkdtemp(join(tmpdir(), 'archive-release-source-change-')); const root = join(work, 'archive'); await mkdir(root);
  const library = await Library.open(root, join(work, 'index.sqlite'));
  try {
    const path = join(root, 'notes.txt'); await writeFile(path, 'originalneedle'); await library.indexFile('notes.txt');
    const result = await library.indexFile('notes.txt', { force: true, extractor: async path => {
      const parsed = await extract(path); await rename(path, join(root, 'old.txt')); await writeFile(path, 'replacementneedle'); return parsed;
    } });
    assert.equal(result.status, 'stale'); assert.equal(result.error, 'changed-during-extraction');
    assert.equal(library.search('originalneedle').length, 1); assert.equal(library.search('replacementneedle').length, 0);
    await library.indexFile('notes.txt'); assert.equal(library.search('replacementneedle').length, 1);
  } finally { library.close(); await rm(work, { recursive: true, force: true }); }
});

test('v1 schema migration preserves realistic data; a failed migration rolls back added columns', async () => {
  const work = await mkdtemp(join(tmpdir(), 'archive-release-migration-')); const root = join(work, 'archive'); await mkdir(root);
  let library: Library | undefined;
  const makeV1 = (path: string, conflict = false) => {
    const db = new DatabaseSync(path); db.exec(`CREATE TABLE files (id TEXT PRIMARY KEY,path TEXT NOT NULL UNIQUE,status TEXT NOT NULL,error TEXT${conflict ? ',subject TEXT' : ''});
      CREATE TABLE passages (id INTEGER PRIMARY KEY,file_id TEXT NOT NULL REFERENCES files(id),text TEXT NOT NULL,page INTEGER,start_line INTEGER,end_line INTEGER);
      CREATE VIRTUAL TABLE passage_search USING fts5(filename,text,tokenize='unicode61'); PRAGMA user_version=1;`);
    db.prepare(`INSERT INTO files (id,path,status) VALUES (?,?,?)`).run('notes.txt', 'notes.txt', 'indexed');
    db.prepare('INSERT INTO passages VALUES (1,?,?,?,?,?)').run('notes.txt', 'migrationneedle', null, 1, 1);
    db.prepare('INSERT INTO passage_search (rowid,filename,text) VALUES (1,?,?)').run('notes.txt', 'migrationneedle'); db.close();
  };
  try {
    const path = join(work, 'v1.sqlite'); makeV1(path); library = await Library.open(root, path);
    assert.equal(library.search('migrationneedle')[0]!.origin, 'embedded'); assert.equal(library.search('migrationneedle')[0]!.type, 'Text'); library.close(); library = undefined;
    const failed = join(work, 'failed.sqlite'); makeV1(failed, true); await assert.rejects(Library.open(root, failed), /duplicate column name/);
    const db = new DatabaseSync(failed);
    try { assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 1); assert.deepEqual(db.prepare('PRAGMA table_info(files)').all().map(row => row.name), ['id', 'path', 'status', 'error', 'subject']); assert.equal(db.prepare('SELECT text FROM passages').get()!.text, 'migrationneedle'); }
    finally { db.close(); }
  } finally { library?.close(); await rm(work, { recursive: true, force: true }); }
});

test('phrases cannot bridge passages; filename-only ranking is stable; filters reset without hidden state', async () => {
  const work = await mkdtemp(join(tmpdir(), 'archive-release-search-')); const root = join(work, 'archive'); await mkdir(root);
  const library = await Library.open(root, join(work, 'index.sqlite'));
  try {
    await writeFile(join(root, 'a.txt'), [...Array(79).fill('filler'), 'boundaryalpha', 'boundarybeta'].join('\n')); await library.indexFile('a.txt');
    assert.equal(library.search('"boundaryalpha boundarybeta"').length, 0); assert.equal(library.search('boundarybeta')[0]!.startLine, 81);
    await writeFile(join(root, 'needle.txt'), 'unrelated content'); await library.indexFile('needle.txt');
    await writeFile(join(root, 'b.md'), 'needle appears in text'); await library.indexFile('b.md');
    const results = library.search('needle'); assert.equal(results.length, 2);
    assert.equal(results.find(row => row.relativePath === 'needle.txt')!.filenameOnly, true); assert.equal(results.find(row => row.relativePath === 'b.md')!.filenameOnly, false);
    assert.equal(library.matches(results.find(row => row.relativePath === 'needle.txt')!.fileId, 'needle')[0]!.filenameOnly, true);
    for (let i = 0; i < 5; i++) assert.deepEqual(library.search('needle'), results);
    assert.equal(library.searchPage('needle', { type: 'PDF' }).total, 0); assert.equal(library.searchPage('needle', {}).total, 2); assert.equal(library.searchPage('needle', { type: 'Markdown' }).total, 1);
    assert.equal(library.searchPage('needle', { type: '' }).total, 2);
  } finally { library.close(); await rm(work, { recursive: true, force: true }); }
});

test('index progress, concurrent starts and repeated saved changes remain consistent across roots', { timeout: 45_000 }, async () => {
  const work = await mkdtemp(join(tmpdir(), 'archive-release-progress-')); const root = join(work, 'archive'); const other = join(work, 'other'); await mkdir(root); await mkdir(other);
  const progress: Job[] = []; const service = new ArchiveService(join(work, 'profile'), job => progress.push(job));
  try {
    await Promise.all(Array.from({ length: 15 }, (_, n) => writeFile(join(root, `${n}.txt`), 'savedneedle'))); await writeFile(join(root, 'bad.docx'), 'malformed');
    await writeFile(join(other, 'other.txt'), 'otherneedle'); await service.init(); await service.prepareRoot(root);
    const [first, second] = await Promise.all([service.start('import'), service.start('import')]); assert.equal(first.id, second.id);
    await assert.rejects(service.prepareRoot(other), /Stop the current import/);
    const job = (await service.whenIdle())!; assert.equal(job.state, 'completed'); assert.equal(job.total, 16); assert.equal(job.processed, 16);
    assert.equal(job.counts.indexed, 15); assert.equal(job.counts.failed, 1); assert.ok(progress.some(row => row.state === 'discovering' && row.total === null));
    for (const row of progress) {
      assert.equal(row.processed, row.counts.indexed + row.counts.partial + row.counts.noText + row.counts.unchanged + row.counts.failed);
      if (row.total !== null) assert.ok(row.total >= row.processed);
    }
    await Promise.all(Array.from({ length: 12 }, () => service.saveSearch('savedneedle', { type: 'Text' }))); assert.equal((await service.saved()).length, 1);
    const match = service.search('savedneedle', {}, 0).results[0]!;
    await Promise.all(Array.from({ length: 12 }, () => service.saveBookmark(match.fileId, match.passageId))); assert.equal((await service.saved()).length, 2);
    await rm(join(root, 'bad.docx')); await service.prepareRoot(other); await service.start('import'); await service.whenIdle(); assert.equal((await service.saved()).length, 0);
    await service.saveSearch('otherneedle', {}); await service.prepareRoot(root); await service.start('import'); await service.whenIdle(); assert.equal((await service.saved()).length, 2);
    const items = await service.saved(); await Promise.all(Array.from({ length: 8 }, () => service.removeSaved(items[0]!.id))); assert.equal((await service.saved()).length, 1);
  } finally { await service.close(); await rm(work, { recursive: true, force: true }); }
});

test('native helpers receive Windows locations and stdin data without ambient secrets or command interpolation', async () => {
  const prior = process.env.SMM_RELEASE_FAKE_SECRET; process.env.SMM_RELEASE_FAKE_SECRET = 'synthetic-secret-never-inherit';
  try {
    const env = nativeEnvironment(); assert.equal(env.SMM_RELEASE_FAKE_SECRET, undefined); assert.equal(env.NODE_OPTIONS, undefined);
    assert.ok(Object.keys(env).some(key => key.toLowerCase() === 'systemroot'));
    const literal = 'quotes " $env:SMM_RELEASE_FAKE_SECRET; $(Get-Process) ` Unicode 日本語';
    const result = await windowsTask('@{ secret=$env:SMM_RELEASE_FAKE_SECRET; literal=$inputData.literal; profile=Test-Path -LiteralPath $env:USERPROFILE } | ConvertTo-Json -Compress', { literal }) as { secret: string | null; literal: string; profile: boolean };
    assert.equal(result.secret, null); assert.equal(result.literal, literal); assert.equal(result.profile, true);
    const controller = new AbortController(); controller.abort(); await assert.rejects(windowsTask('Start-Sleep 60', {}, controller.signal), /abort/i);
    assert.deepEqual(await windowsTask('@{ok=$true} | ConvertTo-Json -Compress', {}), { ok: true });
  } finally { if (prior === undefined) delete process.env.SMM_RELEASE_FAKE_SECRET; else process.env.SMM_RELEASE_FAKE_SECRET = prior; }
});

test('PDF zero-page/malformed inputs and exact byte/page limits are bounded and recoverable', { timeout: 45_000 }, async () => {
  const work = await mkdtemp(join(tmpdir(), 'archive-release-pdf-limits-')); const path = join(work, 'limit.pdf');
  try {
    for (const bytes of [Buffer.from('not a pdf'), Buffer.from('%PDF-1.4\n1 0 obj\n'), syntheticPdf([])]) {
      await writeFile(path, bytes); await assert.rejects(extractBounded(path), /invalid-pdf/);
    }
    const encrypted = syntheticPdf(['protected']).toString().replace('/Root 1 0 R >>', `/Root 1 0 R /Encrypt << /Filter /Standard /V 1 /R 2 /Length 40 /O <${'0'.repeat(64)}> /U <${'0'.repeat(64)}> /P -4 >> /ID [<${'0'.repeat(32)}> <${'0'.repeat(32)}>] >>`);
    await writeFile(path, encrypted); await assert.rejects(extractBounded(path), /encrypted-pdf/);
    await writeFile(path, syntheticPdf(Array(1000).fill(''))); assert.equal((await extractBounded(path)).status, 'no-text');
    await writeFile(path, syntheticPdf(Array(1001).fill(''))); await assert.rejects(extractBounded(path), /page-limit/);
    const pdf = syntheticPdf(['safe byte boundary']); const text = pdf.toString(); const xref = text.indexOf('xref\n');
    let padding = 32 * 1024 * 1024 - pdf.length - 2;
    let tail = '';
    for (let n = 0; n < 3; n++) {
      tail = text.slice(xref).replace(/startxref\n\d+/, `startxref\n${xref + padding + 2}`);
      padding = 32 * 1024 * 1024 - Buffer.byteLength(text.slice(0, xref)) - Buffer.byteLength(tail) - 2;
    }
    const exact = Buffer.concat([pdf.subarray(0, xref), Buffer.from('%' + 'x'.repeat(padding) + '\n'), Buffer.from(tail)]);
    assert.equal(exact.length, 32 * 1024 * 1024); await writeFile(path, exact);
    assert.match((await extractBounded(path)).passages[0]!.text, /safe byte boundary/);
    await writeFile(path, Buffer.concat([exact, Buffer.from('\n')])); await assert.rejects(extractBounded(path), /size-limit/);
    await writeFile(path, syntheticPdf(['recoveredneedle'])); assert.equal((await previewPdf(path, 1)).page, 1);
  } finally { await rm(work, { recursive: true, force: true }); }
});

test('PDF page rendering ignores embedded actions, JavaScript, links and remote resources', async () => {
  const work = await mkdtemp(join(tmpdir(), 'archive-release-pdf-actions-')); let requests = 0;
  const server = createServer((_request, response) => { requests++; response.end('remote'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number }; const url = `http://127.0.0.1:${address.port}/pdf-action`;
  try {
    const objects = [
      `<< /Type /Catalog /Pages 2 0 R /OpenAction << /S /JavaScript /JS (app.launchURL\\(\\"${url}\\"\\)) >> /AA << /WC << /S /URI /URI (${url}) >> >> >>`,
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R /Annots [6 0 R] >>',
      '<< /Length 44 >>\nstream\nBT /F1 12 Tf 10 40 Td (safe local text) Tj ET\nendstream',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      `<< /Type /Annot /Subtype /Link /Rect [0 0 200 100] /A << /S /URI /URI (${url}) >> >>`,
    ];
    let pdf = '%PDF-1.4\n'; const offsets = [0];
    objects.forEach((object, n) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${n + 1} 0 obj\n${object}\nendobj\n`; });
    const xref = Buffer.byteLength(pdf); pdf += `xref\n0 7\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const path = join(work, 'actions.pdf'); await writeFile(path, pdf);
    assert.match((await extractBounded(path)).passages[0]!.text, /safe local text/); assert.equal((await previewPdf(path, 1)).page, 1);
    assert.equal(requests, 0);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(work, { recursive: true, force: true }); }
});

test('disk-full failure at rebuild activation retains the active archive and permits retry', async context => {
  const work = await mkdtemp(join(tmpdir(), 'archive-release-disk-full-')); const root = join(work, 'archive'); const profile = join(work, 'profile'); await mkdir(root);
  const service = new ArchiveService(profile);
  try {
    await writeFile(join(root, 'notes.txt'), 'durableneedle'); await service.init(); await service.prepareRoot(root); await service.start('import'); await service.whenIdle();
    const settings = JSON.parse(await readFile(join(profile, 'settings.json'), 'utf8'));
    const originalRename = fs.rename; let writes = 0;
    const mock = context.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
      if (args[1] === join(profile, 'settings.json') && ++writes === 2) throw Object.assign(new Error('Synthetic disk full'), { code: 'ENOSPC' });
      return originalRename(...args);
    }); syncBuiltinESMExports();
    try {
      await writeFile(join(root, 'notes.txt'), 'newneedle after rebuild'); await service.start('rebuild'); assert.equal((await service.whenIdle())!.state, 'failed');
      assert.equal(service.search('durableneedle', {}, 0).total, 1); assert.equal(service.search('newneedle', {}, 0).total, 0);
      assert.equal(JSON.parse(await readFile(join(profile, 'settings.json'), 'utf8')).database, settings.database);
    } finally { mock.mock.restore(); syncBuiltinESMExports(); }
    await service.start('rebuild'); assert.equal((await service.whenIdle())!.state, 'completed'); assert.equal(service.search('newneedle', {}, 0).total, 1);
  } finally { await service.close(); await rm(work, { recursive: true, force: true }); }
});

test('Saved writes held across root activation retain the original archive identity', async context => {
  const work = await mkdtemp(join(tmpdir(), 'archive-saved-root-race-')); const first = join(work, 'first'); const second = join(work, 'second'); const profile = join(work, 'profile');
  await mkdir(first); await mkdir(second); await writeFile(join(first, 'notes.txt'), 'firstneedle'); await writeFile(join(second, 'notes.txt'), 'secondneedle');
  const service = new ArchiveService(profile); const originalRename = fs.rename;
  let entered!: () => void; let release!: () => void; let held: Promise<void> | undefined;
  const renameMock = context.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (held && args[1] === join(profile, 'saved.json')) { entered(); await held; }
    return originalRename(...args);
  }); syncBuiltinESMExports();
  try {
    await service.init(); await service.prepareRoot(first); await service.start('import'); await service.whenIdle();
    let itemId = '';
    for (const action of ['save', 'remove']) {
      const waiting = new Promise<void>(resolve => { entered = resolve; }); held = new Promise<void>(resolve => { release = resolve; });
      const pending = action === 'save' ? service.saveSearch('firstneedle', {}) : service.removeSaved(itemId);
      await waiting;
      try { await service.prepareRoot(second); await service.start('import'); assert.equal((await service.whenIdle())!.state, 'completed'); }
      finally { release(); held = undefined; }
      const result = await pending; if (action === 'save') { assert.equal(result.length, 1); itemId = result[0]!.id; assert.equal(result[0]!.root, first); }
      else assert.deepEqual(result, []);
      assert.deepEqual(await service.saved(), []); assert.equal(service.search('secondneedle', {}, 0).total, 1);
      await service.prepareRoot(first); await service.start('import'); await service.whenIdle();
      assert.equal((await service.saved()).length, action === 'save' ? 1 : 0);
    }
  } finally { release?.(); renameMock.mock.restore(); syncBuiltinESMExports(); await service.close(); await rm(work, { recursive: true, force: true }); }
});

test('PDF extracted text accepts exactly two million characters and rejects one extra', { timeout: 90_000 }, async () => {
  const work = await mkdtemp(join(tmpdir(), 'archive-pdf-character-limit-')); const path = join(work, 'boundary.pdf');
  try {
    const pages = Array<string>(1000).fill('x'.repeat(2000));
    // Keep all glyphs within the page without changing stream lengths or xref offsets.
    const pdf = () => Buffer.from(syntheticPdf(pages).toString('latin1').replaceAll('/F1 12 Tf', '/F1 .1 Tf'), 'latin1');
    await writeFile(path, pdf()); const result = await extractBounded(path);
    assert.equal(result.passages.reduce((count, passage) => count + passage.text.length, 0), 2_000_000);
    assert.equal(result.passages.at(-1)!.page, 1000);
    pages[999] += 'x'; await writeFile(path, pdf()); await assert.rejects(extractBounded(path), /text-limit/);
    await writeFile(path, syntheticPdf(['recovered after text limit'])); assert.equal((await previewPdf(path, 1)).page, 1);
  } finally { await rm(work, { recursive: true, force: true }); }
});
