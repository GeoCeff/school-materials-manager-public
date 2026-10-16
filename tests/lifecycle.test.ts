import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { execFileSync } from 'node:child_process';
import { ArchiveService } from '../src/core/index.js';
import { inferLabels } from '../src/core/paths.js';
import { syntheticPdf } from '../src/smoke.js';

test('academic metadata works for full hierarchy, subject roots, and unfamiliar paths', () => {
  const labels = inferLabels('Archive', 'First Year 2025-2026/Second Semester/TEST 123/notes.md');
  assert.equal(labels.year, 'First Year 2025-2026'); assert.equal(labels.subject, 'TEST 123');
  assert.equal(inferLabels('TEST 123', 'notes.md').subject, 'TEST 123');
  assert.equal(inferLabels('Archive', 'unfamiliar/notes.md').year, null);
});

test('incremental refresh, filtering, pagination, unavailable roots, interrupted jobs, and safe rebuild', async () => {
  const work = await mkdtemp(join(tmpdir(), 'archive-lifecycle-'));
  const root = join(work, 'archive'); const data = join(work, 'app-data');
  const subject = 'First Year 2025-2026/First Semester/TEST 123';
  await mkdir(join(root, subject), { recursive: true });
  await mkdir(join(root, 'node_modules'));
  await writeFile(join(root, 'node_modules', 'ignored.md'), 'hiddensecret');
  await symlink(work, join(root, 'escape'), 'junction');
  await writeFile(join(root, subject, 'lecture.pdf'), syntheticPdf(['commonneedle durable lecture.']));
  for (let i = 0; i < 28; i++) await writeFile(join(root, subject, `notes-${i}.md`), `commonneedle note ${i}`);
  let service = new ArchiveService(data);
  try {
    await service.init(); await service.prepareRoot(root); await service.start('import');
    const initial = await service.whenIdle(); assert.equal(initial!.state, 'completed'); assert.equal(initial!.processed, 29);
    assert.equal(service.search('hiddensecret', {}, 0).total, 0);
    const first = service.search('commonneedle', {}, 0); assert.equal(first.results.length, 25); assert.equal(first.total, 29);
    assert.equal(service.search('commonneedle', {}, first.nextOffset!).results.length, 4);
    assert.equal(service.search('commonneedle', { type: 'PDF', subject: 'TEST 123' }, 0).total, 1);
    assert.deepEqual(service.options({ year: 'First Year 2025-2026' }).subject, ['TEST 123']);
    assert.deepEqual(service.options({ year: 'unknown', subject: 'invalid' }).type, ['Markdown', 'PDF']);
    await service.start('refresh'); assert.equal((await service.whenIdle())!.counts.unchanged, 29);
    await writeFile(join(root, subject, 'notes-0.md'), 'updatedneedle changed note');
    await rm(join(root, subject, 'notes-1.md'));
    await writeFile(join(root, subject, 'added.txt'), 'addedneedle');
    await service.start('refresh'); const refreshed = await service.whenIdle();
    assert.equal(refreshed!.counts.removed, 1); assert.equal(service.search('updatedneedle', {}, 0).total, 1);
    await writeFile(join(root, subject, 'lecture.pdf'), 'broken');
    await service.start('refresh'); await service.whenIdle();
    assert.equal(service.search('durable', {}, 0).results[0]!.status, 'stale');
    const staleBrowse = await service.browse({ folder: subject, inventory: 'indexed', filters: { type: 'PDF' }, offset: 0 });
    assert.equal(staleBrowse.entries[0]!.kind === 'file' && staleBrowse.entries[0]!.status, 'stale');
    await service.start('rebuild'); assert.equal((await service.whenIdle())!.state, 'failed');
    assert.equal(service.search('durable', {}, 0).total, 1);
    assert.equal((await service.browse({ folder: subject, inventory: 'indexed', filters: {}, offset: 0 })).total, 29);
    await service.start('rebuild'); service.cancel(); assert.equal((await service.whenIdle())!.state, 'cancelled');
    assert.equal(service.search('durable', {}, 0).total, 1);
    await service.close();
    await rename(root, join(work, 'disconnected'));
    service = new ArchiveService(data); await service.init();
    assert.equal((await service.status()).available, false); assert.equal(service.search('durable', {}, 0).total, 1);
    await service.start('refresh'); assert.equal((await service.whenIdle())!.state, 'failed');
    assert.equal(service.search('durable', {}, 0).total, 1);
    await rename(join(work, 'disconnected'), root);
    await writeFile(join(root, subject, 'lecture.pdf'), syntheticPdf(['rebuiltneedle new lecture.']));
    await service.start('rebuild'); assert.equal((await service.whenIdle())!.state, 'completed');
    assert.equal(service.search('rebuiltneedle', {}, 0).total, 1); assert.equal(service.search('durable', {}, 0).total, 0);
    await service.setTheme('dark'); await service.close();
    const settings = JSON.parse(await readFile(join(data, 'settings.json'), 'utf8'));
    settings.lastJob.state = 'processing'; await writeFile(join(data, 'settings.json'), JSON.stringify(settings));
    service = new ArchiveService(data); await service.init();
    assert.equal((await service.status()).theme, 'dark'); assert.equal((await service.status()).job!.state, 'interrupted');
    const match = service.search('rebuiltneedle', {}, 0).results[0]!;
    assert.equal((await service.preview(match.fileId, match.passageId)).page, 1);
    await assert.rejects(service.resolveFile('../escape'), /no longer indexed/);
  } finally { await service.close(); await rm(work, { recursive: true, force: true }); }
});

test('incomplete discovery retains absent entries; hidden attributes are excluded', async () => {
  const work = await mkdtemp(join(tmpdir(), 'archive-discovery-'));
  const root = join(work, 'archive'); const lost = join(root, 'lost');
  await mkdir(lost, { recursive: true });
  await writeFile(join(root, 'keep.md'), 'keptneedle'); await writeFile(join(lost, 'previous.md'), 'previousneedle');
  await writeFile(join(root, 'hidden.md'), 'hiddenneedle');
  if (process.platform === 'win32') execFileSync('attrib.exe', ['+H', join(root, 'hidden.md')], { windowsHide: true });
  else await rename(join(root, 'hidden.md'), join(root, '.hidden.md'));
  let interruptDiscovery = false;
  const service = new ArchiveService(join(work, 'data'), job => {
    if (interruptDiscovery && job.state === 'discovering' && job.current === '1 eligible files found') { interruptDiscovery = false; rmSync(lost, { recursive: true, force: true }); }
  });
  try {
    await service.init(); await service.prepareRoot(root); await service.start('import'); await service.whenIdle();
    assert.equal(service.search('hiddenneedle', {}, 0).total, 0);
    interruptDiscovery = true; await service.start('refresh'); const job = await service.whenIdle();
    assert.equal(job!.pruningSkipped, true); assert.equal(job!.counts.removed, 0); assert.equal(job!.errors.length, 1);
    assert.equal(service.search('previousneedle', {}, 0).total, 1);
    assert.equal((await service.browse({ folder: 'lost', inventory: 'indexed', filters: {}, offset: 0 })).folder, 'lost');
    const result = service.search('previousneedle', {}, 0).results[0]!;
    assert.equal((await service.preview(result.fileId, result.passageId)).availability, 'missing');
  } finally { await service.close(); await rm(work, { recursive: true, force: true }); }
});

test('corrupt settings are preserved, damaged index can be rebuilt, and cancelled first imports keep committed files', async () => {
  const work = await mkdtemp(join(tmpdir(), 'archive-recovery-')); const root = join(work, 'archive'); const data = join(work, 'data');
  await mkdir(root); await mkdir(data); await writeFile(join(data, 'settings.json'), '{broken');
  for (let index = 0; index < 10; index++) await writeFile(join(root, `${index}.pdf`), syntheticPdf(['retainedneedle sample.']));
  let cancel = true;
  let service = new ArchiveService(data, job => { if (cancel && job.state === 'processing' && job.processed > 0) { cancel = false; service.cancel(); } });
  try {
    await service.init(); assert.match((await service.status()).problem!, /settings/);
    await service.prepareRoot(root); await service.start('import'); const job = await service.whenIdle();
    assert.equal(job!.state, 'cancelled'); assert.ok(job!.processed > 0 && job!.processed < 10);
    assert.equal(service.search('retainedneedle', {}, 0).total, job!.processed);
    assert.equal((await service.browse({ folder: '', inventory: 'indexed', filters: {}, offset: 0 })).total, job!.processed);
    await service.close();
    const settings = JSON.parse(await readFile(join(data, 'settings.json'), 'utf8'));
    await writeFile(join(data, settings.database), 'damaged index');
    service = new ArchiveService(data); await service.init(); assert.match((await service.status()).problem!, /index/);
    assert.equal((await service.status()).canRefresh, false);
    await assert.rejects(service.browse({ folder: '', inventory: 'indexed', filters: {}, offset: 0 }), /index is unavailable/);
    assert.equal((await service.browse({ folder: '', inventory: 'all', filters: {}, offset: 0 })).total, 10);
    await service.start('rebuild'); assert.equal((await service.whenIdle())!.state, 'completed');
    assert.equal(service.search('retainedneedle', {}, 0).total, 10);
  } finally { await service.close(); await rm(work, { recursive: true, force: true }); }
});

test('failed temporary-index cleanup releases job ownership and permits retry', async () => {
  const work = await mkdtemp(join(tmpdir(), 'archive-cleanup-'));
  const root = join(work, 'archive'); const data = join(work, 'data');
  await mkdir(root); await writeFile(join(root, 'notes.txt'), 'recoverableneedle');
  let obstruction = '';
  let service = new ArchiveService(data, job => {
    if (!obstruction && job.state === 'discovering') {
      obstruction = join(data, `library-${job.id}.sqlite`);
      mkdirSync(obstruction); writeFileSync(join(obstruction, 'blocker'), 'Keep this obstruction intact.');
    }
  });
  try {
    await service.init(); await service.prepareRoot(root); await service.start('import');
    const failed = await service.whenIdle();
    assert.equal(failed!.state, 'failed');
    assert.match((await service.status()).problem!, /unused index/i);
    assert.equal(await readFile(join(obstruction, 'blocker'), 'utf8'), 'Keep this obstruction intact.');
    await service.start('import'); const retried = await service.whenIdle();
    assert.notEqual(retried!.id, failed!.id); assert.equal(retried!.state, 'completed');
    assert.equal(service.search('recoverableneedle', {}, 0).total, 1);
    await service.close();
    const settings = JSON.parse(await readFile(join(data, 'settings.json'), 'utf8'));
    settings.lastJob = { ...failed, state: 'discovering' };
    await writeFile(join(data, 'settings.json'), JSON.stringify(settings));
    service = new ArchiveService(data); await service.init();
    assert.equal((await service.status()).job!.state, 'interrupted');
    assert.match((await service.status()).problem!, /unused index/i);
    assert.equal((await service.status()).canRefresh, true);
    assert.equal(service.search('recoverableneedle', {}, 0).total, 1);
    assert.equal(await readFile(join(obstruction, 'blocker'), 'utf8'), 'Keep this obstruction intact.');
    await service.start('refresh');
    assert.equal((await service.whenIdle())!.state, 'completed');
    assert.equal((await service.status()).problem, null);
  } finally { await service.close().catch(() => {}); await rm(work, { recursive: true, force: true }); }
});

test('failed first-import settings activation leaves the archive unconfigured and retryable', async context => {
  const work = await mkdtemp(join(tmpdir(), 'archive-activation-'));
  const root = join(work, 'archive'); const data = join(work, 'data');
  await mkdir(root); await writeFile(join(root, 'notes.txt'), 'activationneedle');
  const service = new ArchiveService(data);
  const originalRename = fs.rename; let settingsWrites = 0;
  const renameMock = context.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (args[1] === join(data, 'settings.json') && ++settingsWrites === 2) throw Object.assign(new Error('Simulated disk full'), { code: 'ENOSPC' });
    return originalRename(...args);
  });
  syncBuiltinESMExports();
  try {
    await service.init(); await service.prepareRoot(root); await service.start('import');
    assert.equal((await service.whenIdle())!.state, 'failed');
    assert.equal((await service.status()).root, null);
    const settings = JSON.parse(await readFile(join(data, 'settings.json'), 'utf8'));
    assert.equal(settings.root, null); assert.equal(settings.database, null);
    await service.start('import'); assert.equal((await service.whenIdle())!.state, 'completed');
    assert.equal(service.search('activationneedle', {}, 0).total, 1);
  } finally {
    renameMock.mock.restore(); syncBuiltinESMExports();
    await service.close().catch(() => {}); await rm(work, { recursive: true, force: true });
  }
});

test('appearance save failures retain confirmed settings and a later choice persists across restart', async context => {
  const work = await mkdtemp(join(tmpdir(), 'archive-appearance-'));
  let service = new ArchiveService(work);
  const originalRename = fs.rename;
  let fail = false;
  const renameMock = context.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (fail && args[1] === join(work, 'settings.json')) throw new Error('Simulated disk full');
    return originalRename(...args);
  });
  syncBuiltinESMExports();
  try {
    await service.init(); await service.setTheme('dark'); fail = true;
    await assert.rejects(service.setTheme('light'), /disk full/);
    assert.equal((await service.status()).theme, 'dark');
    assert.equal(JSON.parse(await readFile(join(work, 'settings.json'), 'utf8')).theme, 'dark');
    fail = false; await service.setTheme('system'); await service.close();
    service = new ArchiveService(work); await service.init();
    assert.equal((await service.status()).theme, 'system');
    await assert.rejects(service.setTheme('invalid' as never), /Invalid theme/);
  } finally {
    renameMock.mock.restore(); syncBuiltinESMExports();
    await service.close().catch(() => {}); await rm(work, { recursive: true, force: true });
  }
});
