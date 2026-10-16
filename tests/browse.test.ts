import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { ArchiveService } from '../src/core/index.js';
import { Library } from '../src/core/library.js';
import { archiveRelative } from '../src/core/paths.js';
import type { BrowseRequest } from '../src/core/model.js';
import { syntheticPdf } from '../src/smoke.js';
import { discover, listArchiveDirectory } from '../src/core/discovery.js';
import { windowsPowerShell, windowsTask } from '../src/core/windows.js';

const browse = (service: ArchiveService, folder = '', inventory: BrowseRequest['inventory'] = 'indexed', offset = 0, filters = {}) => service.browse({ folder, inventory, offset, filters });

test('Windows helpers never resolve a same-name executable from the inherited working directory', { skip: process.platform !== 'win32' }, async () => {
  const work = await mkdtemp(join(tmpdir(),'archive-executable-')); const originalDirectory = process.cwd();
  const root = join(work,'archive'); await mkdir(root); await writeFile(join(root,'notes.txt'),'Synthetic archive');
  // This harmless utility cannot execute PowerShell commands or return the expected native-task JSON.
  await copyFile(join(process.env.SystemRoot ?? 'C:\\Windows','System32/where.exe'),join(work,'powershell.exe'));
  try {
    process.chdir(work); assert.ok(isAbsolute(windowsPowerShell));
    const result = await discover(root); assert.equal(result.complete,true); assert.deepEqual(result.files,['notes.txt']);
    assert.deepEqual((await listArchiveDirectory(root,'')).entries.map(entry => entry.name),['notes.txt']);
    assert.deepEqual(await windowsTask('$inputData | ConvertTo-Json -Compress',{synthetic:'trusted native helper'}),{synthetic:'trusted native helper'});
  } finally { process.chdir(originalDirectory); await rm(work,{recursive:true,force:true}); }
});

test('indexed browsing preserves exact hierarchy, placeholders, locators, filters and pagination without reindexing', async () => {
  const work = await mkdtemp(join(tmpdir(), 'archive-browse-'));
  const root = join(work, 'archive');
  await mkdir(root);
  const library = await Library.open(root, join(work, 'index.sqlite'));
  const files = new Map<string, string | Buffer>([
    ['root.txt', 'Root needle.'],
    ['First Year 2025-2026/First Semester/CS 20/notes.md', 'Sibling content.'],
    ['First Year 2025-2026/First Semester/CS 201/notes.md', 'Exact subject needle.'],
    ['First Year 2025-2026/First Semester/CS 201/scanned.pdf', syntheticPdf([null])],
    ['First Year 2025-2026/First Semester/CS 201/failed.pdf', 'broken PDF'],
    ['Unfamiliar %_ café/notes.md', 'Unicode needle.'],
    ['Unfamiliar XX café/notes.md', 'Wildcard sibling.'],
    ['Later page/lecture.pdf', syntheticPdf([null, 'First extracted text on physical page two.'])],
    ['📚 科目/notes.txt', 'Unicode folder with a supplementary character.'],
  ]);
  const hash = async (path: string) => createHash('sha256').update(await readFile(join(root, path))).digest('hex');
  try {
    for (const [path, content] of files) { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), content); await library.indexFile(path); }
    const before = await Promise.all([...files.keys()].map(hash));
    const top = library.browse('', {}, 0);
    assert.equal(top.entries.at(-1)!.relativePath, 'root.txt');
    assert.equal(top.entries.filter(entry => entry.kind === 'folder').length, 5);
    const exact = library.browse('First Year 2025-2026/First Semester/CS 201', {}, 0);
    assert.equal(exact.total, 3);
    assert.deepEqual(exact.entries.map(entry => entry.kind === 'file' && entry.status).sort(), ['failed', 'indexed', 'no-text']);
    assert.equal(library.browse('Unfamiliar %_ café', {}, 0).total, 1);
    assert.equal(library.browse('📚 科目', {}, 0).total, 1); assert.equal(library.hasFolder('📚 科目'), true);
    if (process.platform === 'win32') assert.equal(library.browse('UNFAMILIAR %_ CAFÉ', {}, 0).total, 1);
    assert.equal(library.browse('', { subject: 'CS 201' }, 0).total, 1);
    assert.equal(library.browse('First Year 2025-2026/First Semester', { subject: 'CS 201' }, 0).entries[0]!.name, 'CS 201');
    assert.equal(library.browse('First Year 2025-2026/First Semester/CS 20', { subject: 'CS 201' }, 0).total, 0);
    const pageFile = library.browse('Later page', {}, 0).entries[0]!;
    assert.equal(pageFile.kind, 'file');
    if (pageFile.kind === 'file') assert.equal((await library.preview(pageFile.fileId!, pageFile.passageId!)).page, 2);
    for (let i = 0; i < 56; i++) { const path = `many/${String(i).padStart(2, '0')}.txt`; await mkdir(join(root, 'many'), { recursive: true }); await writeFile(join(root, path), 'pagination needle'); await library.indexFile(path); }
    const first = library.browse('many', {}, 0); assert.equal(first.entries.length, 50); assert.equal(first.nextOffset, 50);
    const second = library.browse('many', {}, first.nextOffset!); assert.equal(second.entries.length, 6); assert.equal(second.nextOffset, null);
    assert.equal(new Set([...first.entries, ...second.entries].map(entry => entry.relativePath)).size, 56);
    for (const invalid of ['../escape', '/absolute', 'C:\\escape', '\\\\server\\share', 'a/../escape', 'a//b', 'a\0b', '.secret', 'node_modules/a']) assert.throws(() => library.browse(invalid, {}, 0));
    assert.throws(() => library.browse('', {}, -1)); assert.throws(() => library.browse('', {}, 1.5));
    assert.equal(archiveRelative('A\\B'), 'A/B');
    assert.deepEqual(await Promise.all([...files.keys()].map(hash)), before);
  } finally { library.close(); await rm(work, { recursive: true, force: true }); }
});

test('live inventory exposes empty/unsupported/unindexed entries, excludes unsafe paths and keeps offline cached browsing', async () => {
  const work = await mkdtemp(join(tmpdir(), 'archive-inventory-'));
  const root = join(work, 'archive'); const outside = join(work, 'outside'); const data = join(work, 'data');
  await mkdir(join(root, 'Folder', 'nested'), { recursive: true }); await mkdir(outside);
  await mkdir(join(root, 'empty')); await mkdir(join(root, 'node_modules'));
  await writeFile(join(root, 'Folder', 'existing.txt'), 'stored needle');
  await writeFile(join(outside, 'private.txt'), 'outside secret');
  await writeFile(join(root, '.hidden.txt'), 'hidden');
  await symlink(outside, join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  if (process.platform === 'win32') {
    await writeFile(join(root, 'hidden-system.txt'), 'hidden'); execFileSync('attrib.exe', ['+h', '+s', join(root, 'hidden-system.txt')]);
    await mkdir(join(root, 'hidden-parent')); await writeFile(join(root, 'hidden-parent', 'child.txt'), 'hidden'); execFileSync('attrib.exe', ['+h', join(root, 'hidden-parent')]);
  }
  const service = new ArchiveService(data);
  try {
    await service.init(); await service.prepareRoot(root); await service.start('import'); assert.equal((await service.whenIdle())!.state, 'completed');
    await writeFile(join(root, 'new.txt'), 'unindexed needle'); await writeFile(join(root, 'paper.xlsx'), 'unsupported bytes');
    const live = await browse(service, '', 'all', 0, { subject: 'no matching subject' });
    assert.deepEqual(live.entries.map(entry => entry.name), ['empty', 'Folder', 'new.txt', 'paper.xlsx']);
    assert.equal((await browse(service, 'empty', 'all')).total, 0);
    const unindexed = live.entries.find(entry => entry.name === 'new.txt')!; const unsupported = live.entries.find(entry => entry.name === 'paper.xlsx')!;
    assert.equal(unindexed.kind === 'file' && unindexed.status, 'not-indexed'); assert.equal(unsupported.kind === 'file' && unsupported.status, 'unsupported');
    assert.equal(service.search('unindexed', {}, 0).total, 0);
    assert.equal(relative(root, await service.resolveEntry(root, 'paper.xlsx')), 'paper.xlsx');
    for (const path of ['../outside/private.txt', 'link/private.txt', '.hidden.txt', 'node_modules', '/absolute']) await assert.rejects(service.resolveEntry(root, path));
    if (process.platform === 'win32') {
      await assert.rejects(service.resolveEntry(root, 'hidden-system.txt'));
      await assert.rejects(service.resolveEntry(root, 'hidden-parent/child.txt'));
      await assert.rejects(browse(service, 'hidden-parent', 'all'));
    }
    await assert.rejects(service.resolveEntry(outside, 'private.txt'));
    await assert.rejects(browse(service, 'link', 'all'));
    await service.start('refresh'); await service.whenIdle();
    const refreshed = (await browse(service, '', 'all')).entries.find(entry => entry.name === 'new.txt')!;
    assert.equal(refreshed.kind === 'file' && refreshed.status, 'indexed');
    const replacement = join(work, 'replacement'); await mkdir(replacement); await writeFile(join(replacement, 'broken.pdf'), 'broken');
    await service.prepareRoot(replacement); await service.start('import'); assert.equal((await service.whenIdle())!.state, 'failed');
    assert.equal((await service.status()).root, root); assert.equal((await browse(service, 'Folder')).total, 1);
    await rename(root, root + '-offline');
    assert.equal((await browse(service, 'Folder')).total, 1);
    await assert.rejects(browse(service, '', 'all'));
    await rename(root + '-offline', root);
    await rm(join(root, 'Folder'), { recursive: true });
    await service.start('refresh'); await service.whenIdle();
    assert.equal((await browse(service, 'Folder/nested')).folder, '');
    await symlink(outside, join(root, 'Folder'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(browse(service, 'Folder', 'all'));
    await assert.rejects(service.resolveEntry(root, 'Folder/private.txt'));
  } finally { await service.close(); await rm(work, { recursive: true, force: true }); }
});

test('large live folders paginate a bounded incomplete inventory and cancel superseded reads', async () => {
  const work = await mkdtemp(join(tmpdir(), 'archive-large-browse-'));
  const root = join(work, 'archive'); await mkdir(root);
  const service = new ArchiveService(join(work, 'data'));
  try {
    await writeFile(join(root, 'seed.txt'), 'seed'); await service.init(); await service.prepareRoot(root); await service.start('import'); await service.whenIdle();
    // Batch fixture writes so this check stays cheap without recursively indexing 10,000 files.
    for (let start = 0; start < 10_010; start += 100) await Promise.all(Array.from({ length: Math.min(100, 10_010 - start) }, (_, i) => writeFile(join(root, `${String(start + i).padStart(5, '0')}.zip`), 'inert')));
    const late = browse(service, '', 'all'); const cancelled = assert.rejects(late, /superseded/);
    assert.equal((await browse(service)).total, 1); await cancelled;
    const page = await browse(service, '', 'all'); assert.equal(page.entries.length, 50); assert.equal(page.total, null); assert.equal(page.limited, true); assert.equal(page.nextOffset, 50);
    const second = await browse(service, '', 'all', 50); assert.equal(second.entries.length, 50);
    assert.equal(new Set([...page.entries, ...second.entries].map(entry => entry.relativePath)).size, 100);
  } finally { await service.close(); await rm(work, { recursive: true, force: true }); }
});
