import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { ArchiveService } from '../src/core/index.js';
import { CollectionService } from '../src/core/collection.js';
import { clearChoices, LocalDataRemoval } from '../src/core/local-data.js';
import { windowsPowerShell } from '../src/core/windows.js';

const options = { year: '2026-2027', semester: 'First Semester', school: 'manual' as const, course: 'SYN 101' };
const all = { indexes: true, saved: true, collection: true, copies: true };
async function fixture() {
  const work = await mkdtemp(join(tmpdir(), 'archive-clear-synthetic-'));
  const data = join(work, 'profile'); const root = join(work, 'archive'); const original = join(work, 'original.txt');
  await mkdir(root); await writeFile(original, 'synthetic private marker original'); await writeFile(join(root, 'untracked.txt'), 'synthetic untracked original');
  const archive = new ArchiveService(data); const collection = new CollectionService(data, async () => { throw new Error('No live downloads'); });
  await archive.init(); await collection.init(); await collection.prepareLocal(root, [original], options);
  await collection.start(collection.snapshot().plan!.items.map(item => item.id)); await collection.whenIdle();
  await archive.prepareRoot(root); await archive.start('import'); await archive.whenIdle();
  await archive.saveSearch('private marker', {}); await archive.start('rebuild'); await archive.whenIdle();
  const removal = new LocalDataRemoval(data, archive, collection);
  return { work, data, root, original, archive, collection, removal, async close() { await archive.close(); await collection.close(); await rm(work, { recursive: true, force: true }); } };
}

test('a root switch invalidates deletion review before schedule authorization or file removal', async () => {
  const f = await fixture(); let authorized = false;
  try {
    const review = await f.removal.prepare(all); const copied = join(f.root, review.copies[0]!.path); const before = await readFile(copied);
    const other = join(f.work, 'other-archive'); await mkdir(other); await writeFile(join(other, 'notes.txt'), 'other archive content');
    await f.archive.prepareRoot(other); await f.archive.start('import'); await f.archive.whenIdle();
    await assert.rejects(f.removal.execute(review.id, review.copies.map(copy => copy.path), async () => { authorized = true; }), /changed after review/);
    assert.equal(authorized, false); assert.deepEqual(await readFile(copied), before); assert.equal(await readFile(f.original, 'utf8'), 'synthetic private marker original');
    assert.equal((await f.archive.status()).root, other); assert.equal(f.archive.search('other archive content', {}, 0).total, 1);
  } finally { await f.close(); }
});

test('review cancellation, invalid choices and unreviewed copy paths never remove data', async () => {
  const f = await fixture();
  try {
    assert.throws(() => clearChoices({ ...all, extra: true }), /Choose/);
    assert.throws(() => clearChoices({ indexes: false, saved: false, collection: false, copies: false }), /Choose/);
    const reviewed = await f.removal.prepare(all); const before = await readFile(f.original);
    assert.ok(reviewed.appFiles.filter(name => /^library-.*\.sqlite$/.test(name)).length >= 2);
    assert.equal(reviewed.copies.length, 1); f.removal.cancel();
    await assert.rejects(f.removal.execute(reviewed.id, []), /Review/);
    const again = await f.removal.prepare(all);
    await assert.rejects(f.removal.execute(again.id, ['../original.txt']), /Select only/);
    assert.deepEqual(await readFile(f.original), before); assert.equal((await f.archive.saved()).length, 1);
    assert.equal(f.archive.search('marker', {}, 0).total, 1);
  } finally { await f.close(); }
});

test('invalid, expired and changed removal reviews preserve scheduling until all validation succeeds', async () => {
  const f = await fixture(); const now = Date.now;
  let enabled = true, authorizations = 0;
  const authorize = async () => { enabled = false; authorizations++; };
  try {
    let review = await f.removal.prepare(all);
    await assert.rejects(f.removal.execute(randomUUID(), [], authorize), /Review/);
    review = await f.removal.prepare(all);
    await assert.rejects(f.removal.execute(review.id, ['not-reviewed.txt'], authorize), /Select only/);
    review = await f.removal.prepare(all);
    Date.now = () => now() + 6 * 60_000;
    try { await assert.rejects(f.removal.execute(review.id, [], authorize), /Review/); }
    finally { Date.now = now; }
    review = await f.removal.prepare(all);
    const temporary = join(f.data, `saved-${randomUUID()}.tmp`);
    await writeFile(temporary, 'scope changed after review');
    await assert.rejects(f.removal.execute(review.id, [], authorize), /changed after review/);
    await rm(temporary);
    review = await f.removal.prepare(all);
    const copy = join(f.root, review.copies[0]!.path); const before = await readFile(copy);
    await writeFile(copy, 'edited after review');
    await assert.rejects(f.removal.execute(review.id, [review.copies[0]!.path], authorize), /changed after review/);
    assert.equal(enabled, true); assert.equal(authorizations, 0);
    assert.equal((await f.archive.saved()).length, 1);
    await writeFile(copy, before);
    review = await f.removal.prepare(all);
    await assert.rejects(f.removal.execute(review.id, [], async () => { throw new Error('Schedule storage failed'); }), /Schedule storage failed/);
    assert.equal((await f.archive.saved()).length, 1); assert.equal((await f.archive.status()).root, f.root);
    review = await f.removal.prepare({ indexes: false, saved: true, collection: false, copies: false });
    const result = await f.removal.execute(review.id, [], authorize);
    assert.equal(enabled, false); assert.equal(authorizations, 1); assert.ok(result.removed > 0);
    assert.equal((await f.archive.saved()).length, 0);
    assert.equal(await readFile(f.original, 'utf8'), 'synthetic private marker original');
  } finally { Date.now = now; await f.close(); }
});

test('confirmed all-data removal deletes active/retained indexes and selected copies, preserving originals and connections', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.data, 'connections.bin'), 'synthetic opaque credential placeholder');
    await writeFile(join(f.data, 'unrecognized.txt'), 'must stay');
    await writeFile(join(f.data, 'downloads', `${randomUUID()}.part`), 'synthetic staged bytes');
    const managed = (await f.collection.removalCopies(f.root)).copies[0]!.path.split(/[\\/]/).slice(0,2);
    await writeFile(join(f.root,...managed,'.staging',`${randomUUID()}.part`),'synthetic interrupted publication');
    const review = await f.removal.prepare(all);
    assert.equal(review.copies.length,2);
    const result = await f.removal.execute(review.id, review.copies.map(copy => copy.path));
    assert.deepEqual(result.failures, []); assert.equal((await f.archive.status()).root, null);
    assert.ok(!(await readdir(f.data)).some(name => /^library-/.test(name) || name === 'saved.json' || name === 'settings.json'));
    assert.equal((await readdir(join(f.data, 'downloads'))).length, 0);
    assert.equal(f.collection.snapshot().plan, null);
    for (const copy of review.copies) await assert.rejects(readFile(join(f.root, copy.path)), { code: 'ENOENT' });
    assert.equal(await readFile(f.original, 'utf8'), 'synthetic private marker original');
    assert.equal(await readFile(join(f.root, 'untracked.txt'), 'utf8'), 'synthetic untracked original');
    assert.equal(await readFile(join(f.data, 'connections.bin'), 'utf8'), 'synthetic opaque credential placeholder');
    assert.equal(await readFile(join(f.data, 'unrecognized.txt'), 'utf8'), 'must stay');
    await f.archive.prepareRoot(f.root); await f.archive.start('import'); await f.archive.whenIdle();
    assert.equal((await f.archive.saved()).length, 0); // New profile state works after closing/deleting/reopening SQLite.
  } finally { await f.close(); }
});

test('scope choices and individual copy selection preserve unselected data', async () => {
  const f = await fixture();
  try {
    const review = await f.removal.prepare({ indexes: false, saved: true, collection: false, copies: true });
    const copy = join(f.root, review.copies[0]!.path); const before = await readFile(copy);
    const result = await f.removal.execute(review.id, []);
    assert.deepEqual(result.failures, []); assert.equal(result.preserved.length, 1, JSON.stringify({review, result})); assert.deepEqual(await readFile(copy), before);
    assert.equal((await f.archive.saved()).length, 0); assert.equal(f.archive.search('marker', {}, 0).total, 1); assert.ok(f.collection.snapshot().plan);
  } finally { await f.close(); }
});

test('edited, missing and hardlinked copies are preserved, and changes after review invalidate the receipt', async () => {
  const f = await fixture();
  try {
    const review = await f.removal.prepare(all); const copy = join(f.root, review.copies[0]!.path);
    await writeFile(copy, 'my edited copy');
    await assert.rejects(f.removal.execute(review.id, [review.copies[0]!.path]), /changed after review/);
    const edited = await f.removal.prepare(all); assert.equal(edited.copies.length, 0); assert.equal(edited.preserved.length, 1, JSON.stringify(edited));
    assert.equal(await readFile(copy, 'utf8'), 'my edited copy');
    await rm(copy); const missing = await f.removal.prepare(all); assert.equal(missing.preserved.length, 1);
    await link(f.original, copy); const linked = await f.removal.prepare(all); assert.equal(linked.copies.length, 0); assert.equal(linked.preserved.length, 1);
    await rm(copy); await symlink(process.platform === 'win32' ? dirname(f.original) : f.original, copy, process.platform === 'win32' ? 'junction' : 'file');
    const redirected = await f.removal.prepare(all); assert.equal(redirected.copies.length, 0); assert.equal(redirected.preserved.length, 1);
    assert.equal(await readFile(f.original, 'utf8'), 'synthetic private marker original');
  } finally { await f.close(); }
});

test('redirected app staging is rejected and newly added owned files invalidate an earlier scope', async () => {
  const f = await fixture();
  try {
    const review = await f.removal.prepare(all);
    await writeFile(join(f.data, `saved-${randomUUID()}.tmp`), 'new staged saved item');
    await assert.rejects(f.removal.execute(review.id, []), /changed after review/);
    await rm(join(f.data, 'downloads'), { recursive: true });
    await symlink(f.root, join(f.data, 'downloads'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(f.removal.prepare(all), /redirected/);
    assert.equal(await readFile(f.original, 'utf8'), 'synthetic private marker original');
  } finally { await f.close(); }
});

test('corrupt managed-owner paths fail closed before touching files outside the archive', async () => {
  const f = await fixture(); const database = new DatabaseSync(join(f.data,'collection.sqlite'));
  try {
    database.prepare('UPDATE collection_destinations SET id=? WHERE root=?').run('../../outside',f.root);
    await assert.rejects(f.removal.prepare(all), /ownership records cannot be verified/);
    assert.equal(await readFile(f.original,'utf8'),'synthetic private marker original');
    assert.equal((await f.archive.saved()).length,1);
  } finally { database.close(); await f.close(); }
});

test('locked app files report failure while preserving remaining data and allowing retry', { skip: process.platform !== 'win32' }, async () => {
  const f = await fixture(); let child: ReturnType<typeof spawn> | undefined;
  try {
    const review = await f.removal.prepare({ indexes: false, saved: true, collection: false, copies: false });
    const script = "$f=[IO.File]::Open($env:SYNTHETIC_CLEAR_FILE,'Open','Read','Read'); [Console]::WriteLine('LOCKED'); [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null; $f.Dispose()";
    child = spawn(windowsPowerShell, ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')], { windowsHide: true, env: { ...process.env, SYNTHETIC_CLEAR_FILE: join(f.data,'saved.json') } });
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Lock fixture timed out')), 10000); child!.stdout!.once('data', data => { clearTimeout(timer); data.toString().includes('LOCKED') ? resolve() : reject(new Error('Fixture did not lock')); }); child!.once('error', reject); child!.once('exit', () => reject(new Error('Lock fixture exited'))); });
    const result = await f.removal.execute(review.id, []); assert.equal(result.failures.length, 1); assert.equal((await f.archive.saved()).length, 1);
    const exited = new Promise(resolve => child!.once('exit', resolve)); child.stdin!.end('\n'); await exited; child = undefined;
    const retry = await f.removal.prepare({ indexes: false, saved: true, collection: false, copies: false });
    assert.deepEqual((await f.removal.execute(retry.id, [])).failures, []);
  } finally { if (child) { const exited = new Promise(resolve => child!.once('exit', resolve)); child.kill(); await exited; } await f.close(); }
});
