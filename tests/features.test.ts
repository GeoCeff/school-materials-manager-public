import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Library } from '../src/core/library.js';
import { extractBounded } from '../src/core/extract.js';
import { syntheticDocx, syntheticPptx, syntheticZip } from '../src/office-fixtures.js';
import { createCanvas } from '@napi-rs/canvas';
import { recognizeImage } from '../src/core/ocr.js';
import { previewPdf } from '../src/core/extract.js';
import { syntheticPdf, syntheticScan } from '../src/smoke.js';
import { ArchiveService } from '../src/core/index.js';
import { restoreWindow, saveWindow } from '../src/desktop/window-state.js';
import { DatabaseSync } from 'node:sqlite';

test('Office extraction preserves paragraph and presentation-order locators without opening originals', async () => {
  const work = await mkdtemp(join(tmpdir(), 'archive-office-')); const root = join(work, 'archive'); await mkdir(root);
  const library = await Library.open(root, join(work, 'index.sqlite'));
  try {
    const docx = syntheticDocx(['Intro', '', 'Café & résumé: orbital momentum.']);
    const pptx = syntheticPptx(['First slide', 'Lunar telescope on the second slide.']);
    await writeFile(join(root, 'notes.docx'), docx); await writeFile(join(root, 'lecture.pptx'), pptx);
    assert.equal((await library.indexFile('notes.docx', { extractor: extractBounded })).status, 'indexed');
    assert.equal((await library.indexFile('lecture.pptx', { extractor: extractBounded })).status, 'indexed');
    const word = library.search('orbital')[0]!; assert.equal(word.type, 'Word'); assert.equal(word.startLine, 3); assert.match(word.text, /Café & résumé/);
    const slide = library.search('telescope')[0]!; assert.equal(slide.type, 'Slides'); assert.equal(slide.page, 2);
    assert.deepEqual(await readFile(join(root, 'notes.docx')), docx); assert.deepEqual(await readFile(join(root, 'lecture.pptx')), pptx);
    await writeFile(join(root, 'unsafe.docx'), syntheticZip({ 'word/document.xml': '<!DOCTYPE document [<!ENTITY leak SYSTEM "file:///C:/Windows/win.ini">]><document><body><p><t>&leak;</t></p></body></document>' }));
    await assert.rejects(extractBounded(join(root, 'unsafe.docx')), /invalid-office/);
    await writeFile(join(root, 'oversized.docx'), syntheticZip(Object.fromEntries(Array.from({ length: 5001 }, (_, i) => [`part${i}`, '']))));
    await assert.rejects(extractBounded(join(root, 'oversized.docx')), /office-limit/);
  } finally { library.close(); await rm(work, { recursive: true, force: true }); }
});

test('saved locations survive rebuild and restart; OCR refresh adds provenance without changing originals', async () => {
  const work = await mkdtemp(join(tmpdir(), 'archive-saved-')); const root = join(work, 'archive'); const data = join(work, 'data'); await mkdir(root);
  let service = new ArchiveService(data);
  const bytes = syntheticScan(); await writeFile(join(root, 'scan.pdf'), bytes); await writeFile(join(root, 'notes.txt'), 'durable bookmark');
  try {
    await service.init(); await service.prepareRoot(root); await service.start('import'); assert.equal((await service.whenIdle())!.state, 'completed');
    assert.equal(service.search('2042', {}, 0).total, 0);
    const found = service.search('durable', {}, 0).results[0]!;
    await Promise.all([service.saveSearch('durable', {}), service.saveBookmark(found.fileId, found.passageId)]);
    assert.equal((await service.saved()).length, 2);
    await service.saveBookmark(found.fileId, found.passageId); assert.equal((await service.saved()).length, 2);
    await service.start('rebuild'); assert.equal((await service.whenIdle())!.state, 'completed');
    await service.close(); service = new ArchiveService(data); await service.init();
    const bookmark = (await service.saved()).find(item => item.kind === 'bookmark')!;
    assert.match((await service.openBookmark(bookmark.id)).text, /durable/);
    await service.setOcr(true); await service.start('refresh'); assert.equal((await service.whenIdle())!.state, 'completed');
    const ocr = service.search('2042', {}, 0).results[0]!; assert.ok(ocr); assert.match(ocr.origin!, /^ocr:/); assert.equal(ocr.page, 1);
    assert.deepEqual(await readFile(join(root, 'scan.pdf')), bytes);
    await service.setOcr(false); await service.start('refresh'); await service.whenIdle(); assert.equal(service.search('2042', {}, 0).total, 0);
    await writeFile(join(root, 'notes.txt'), 'replacement text at the same line'); await service.start('refresh'); await service.whenIdle();
    await assert.rejects(service.openBookmark(bookmark.id), /no longer indexed/);
    const other = join(work, 'other'); await mkdir(other); await writeFile(join(other, 'notes.txt'), 'different archive');
    await service.prepareRoot(other); await service.start('import'); await service.whenIdle(); assert.equal((await service.saved()).length, 0);
    await assert.rejects(service.openBookmark(bookmark.id), /unavailable/);
    await service.prepareRoot(root); await service.start('import'); await service.whenIdle(); assert.equal((await service.saved()).length, 2);
    await writeFile(join(data, 'saved.json'), '{bad saved data'); await assert.rejects(service.saveSearch('durable', {}), /retained/);
    assert.equal(await readFile(join(data, 'saved.json'), 'utf8'), '{bad saved data');
  } finally { await service.close(); await rm(work, { recursive: true, force: true }); }
});

test('window restoration recovers disconnected monitors and malformed preferences', async () => {
  const work = await mkdtemp(join(tmpdir(), 'archive-window-')); const path = join(work, 'window.json'); const screen = { x: 0, y: 0, width: 1280, height: 720 };
  try {
    saveWindow(path, { x: -4000, y: -1000, width: 2000, height: 1400 }, true);
    assert.deepEqual(restoreWindow(path, [screen]), { ...screen, maximized: true });
    await writeFile(path, '{malformed'); const restored = restoreWindow(path, [screen]); assert.equal(restored.maximized, false); assert.ok(restored.x >= 0 && restored.y >= 0);
  } finally { await rm(work, { recursive: true, force: true }); }
});

test('offline Windows OCR reads synthetic pixels and bounded PDF previews render actual pages', async () => {
  const canvas = createCanvas(1500, 240); const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff'; context.fillRect(0, 0, 1500, 240); context.fillStyle = '#000000'; context.font = '64px Arial'; context.fillText('LUNAR TELESCOPE 2042', 70, 130);
  const result = await recognizeImage(canvas.toBuffer('image/png'));
  assert.match(result.text, /LUNAR TELESCOPE 2042/i); assert.ok(result.language);
  const work = await mkdtemp(join(tmpdir(), 'archive-pdf-preview-'));
  try {
    const path = join(work, 'pages.pdf'); await writeFile(path, syntheticPdf(['Page one', 'Lunar telescope']));
    const page = await previewPdf(path, 2); assert.equal(page.page, 2); assert.equal(page.pages, 2); assert.match(page.image, /^data:image\/png;base64,/); assert.ok(page.width * page.height <= 4_010_000);
    await assert.rejects(previewPdf(path, 3), /invalid-page/);
  } finally { await rm(work, { recursive: true, force: true }); }
});

test('version two indexes migrate without re-extracting passages', async () => {
  const work = await mkdtemp(join(tmpdir(), 'archive-migrate-')); const root = join(work, 'archive'); await mkdir(root); const path = join(work, 'index.sqlite');
  let library: Library | undefined;
  try {
    await writeFile(join(root, 'notes.txt'), 'migration preserves this passage'); library = await Library.open(root, path); await library.indexFile('notes.txt'); library.close(); library = undefined;
    const old = new DatabaseSync(path); old.exec('ALTER TABLE passages DROP COLUMN origin; PRAGMA user_version=2'); old.close();
    library = await Library.open(root, path); assert.equal(library.search('migration')[0]!.origin, 'embedded'); assert.equal((await library.indexFile('notes.txt')).status, 'unchanged');
    library.close(); library = await Library.open(root, path); assert.equal(library.search('migration').length, 1);
  } finally { library?.close(); await rm(work, {recursive:true,force:true}); }
});
