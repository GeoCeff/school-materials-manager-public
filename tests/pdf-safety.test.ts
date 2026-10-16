import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { extractBounded, previewPdf } from '../src/core/extract.js';
import { BoundedCanvasFactory } from '../src/core/pdf.js';
import { Library } from '../src/core/library.js';
import { syntheticPdf } from '../src/smoke.js';
import { compressedImagePdf } from './pdf-fixtures.js';
import { loadImage, createCanvas } from '@napi-rs/canvas';

test('PDF native canvases reject excessive dimensions, pixels and aggregate allocations before creating them', () => {
  const factory = new BoundedCanvasFactory();
  for (const [width, height] of [[Infinity, 1], [NaN, 1], [-1, 1], [0, 1], [9000, 1], [2001, 2000]]) {
    assert.throws(() => factory.create(width!, height!), /pdf-render-limit/);
  }
  const entries = Array.from({ length: 4 }, () => factory.create(2000, 2000));
  try {
    assert.throws(() => factory.create(1, 1), /pdf-render-limit/);
    assert.throws(() => factory.reset(entries[0]!, 9000, 1), /pdf-render-limit/);
    assert.equal(entries[0]!.canvas.width, 2000);
    factory.reset(entries[0]!, 1, 1);
    const reused = factory.create(2000, 1999); factory.destroy(reused);
  } finally { entries.forEach(entry => factory.destroy(entry)); }
  const after = factory.create(2000, 2000); factory.destroy(after);
});

test('a compressed 6000 by 6000 image is rejected before decoding and a later valid preview still works', async t => {
  const work = await mkdtemp(join(tmpdir(), 'archive-pdf-safety-'));
  try {
    const path = join(work, 'compressed.pdf'); const fixture = await compressedImagePdf();
    assert.ok(fixture.length < 110_000); await writeFile(path, fixture);
    const script = `import assert from 'node:assert/strict';
      import { previewPdf } from ${JSON.stringify(new URL('../src/core/extract.js', import.meta.url).href)};
      await assert.rejects(previewPdf(process.argv[1], 1), /pdf-render-limit/);
      process.stdout.write(JSON.stringify({ parentPeakKiB: process.resourceUsage().maxRSS }) + '\\n');`;
    const result = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', script, path], { timeout: 15_000, windowsHide: true });
    const memory = JSON.parse(result.stdout.trim().split('\n').at(-1)!) as { parentPeakKiB: number };
    // The caller stays small; the separate native probes verify Windows job allocation enforcement.
    assert.ok(memory.parentPeakKiB < 128 * 1024, `caller peak RSS was ${memory.parentPeakKiB} KiB`);
    t.diagnostic(JSON.stringify({ fixtureBytes: fixture.length, ...memory }));
    const valid = join(work, 'valid.pdf'); await writeFile(valid, syntheticPdf(['valid after rejected image']));
    assert.equal((await previewPdf(valid, 1)).page, 1);
    const normal = join(work, 'normal-image.pdf'); await writeFile(normal, syntheticPdf([null]));
    const page = await previewPdf(normal, 1); const pixels = await loadImage(page.image);
    const canvas = createCanvas(page.width, page.height); const context = canvas.getContext('2d'); context.drawImage(pixels, 0, 0);
    const rendered = context.getImageData(0, 0, page.width, page.height).data;
    assert.ok(rendered.some((value, index) => index % 4 !== 3 && value < 32), 'a normal image must paint dark pixels');
    canvas.width = canvas.height = 0;
    assert.deepEqual(await readFile(path), fixture);
  } finally { await rm(work, { recursive: true, force: true }); }
});

test('blocked PDF image OCR retains embedded text as partial and stores an honest limitation after reopening', async () => {
  const work = await mkdtemp(join(tmpdir(), 'archive-pdf-partial-')); let library: Library | undefined;
  try {
    const root = join(work, 'archive'); await mkdir(root);
    const path = join(root, 'mixed.pdf'); const fixture = await compressedImagePdf(true); await writeFile(path, fixture);
    const originalHash = createHash('sha256').update(fixture).digest('hex');
    const result = await extractBounded(path, undefined, true);
    assert.equal(result.status, 'partial'); assert.equal(result.limitation, 'pdf-render-limit');
    assert.equal(result.passages.length, 1); assert.match(result.passages[0]!.text, /safe embedded marker/);
    assert.equal(result.passages[0]!.page, 2); assert.equal(result.passages[0]!.origin, 'embedded');
    const database = join(work, 'index.sqlite'); library = await Library.open(root, database);
    const outcome = await library.indexFile('mixed.pdf', { extractor: file => extractBounded(file, undefined, true) });
    assert.equal(outcome.status, 'partial'); assert.equal(outcome.error, 'pdf-render-limit');
    library.close(); library = await Library.open(root, database);
    const match = library.search('marker')[0]!; const preview = await library.preview(match.fileId, match.passageId);
    assert.equal(preview.status, 'partial'); assert.equal(preview.error, 'pdf-render-limit');
    await writeFile(join(root, 'image-only.pdf'), await compressedImagePdf());
    const empty = await extractBounded(join(root, 'image-only.pdf'), undefined, true);
    assert.equal(empty.status, 'no-text'); assert.equal(empty.limitation, 'pdf-render-limit'); assert.equal(empty.passages.length, 0);
    assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'), originalHash);
  } finally { library?.close(); await rm(work, { recursive: true, force: true }); }
});

test('a large valid PDF page scales within the strict native pixel limit', async () => {
  const work = await mkdtemp(join(tmpdir(), 'archive-pdf-large-page-'));
  try {
    const path = join(work, 'large-page.pdf'); await writeFile(path, await compressedImagePdf(true, [1224, 1584]));
    const page = await previewPdf(path, 2);
    assert.equal(page.page, 2); assert.ok(page.width > 1000 && page.height > 1000);
    assert.ok(page.width * page.height <= 4_000_000);
  } finally { await rm(work, { recursive: true, force: true }); }
});

test('cancelling active and queued isolated PDF requests leaves the next request usable', { timeout: 15_000 }, async () => {
  const work = await mkdtemp(join(tmpdir(), 'archive-pdf-cancel-'));
  try {
    const path = join(work, 'valid.pdf'); await writeFile(path, syntheticPdf(['a valid page after cancellation']));
    await assert.rejects(previewPdf(path, 0), /invalid-page/); await assert.rejects(previewPdf(path, 1001), /invalid-page/);
    const controllers = Array.from({ length: 3 }, () => new AbortController());
    const pending = controllers.map(controller => previewPdf(path, 1, controller.signal).then(() => 'completed', error => error.category));
    controllers[2]!.abort(); setTimeout(() => { controllers[0]!.abort(); controllers[1]!.abort(); }, 10);
    assert.deepEqual(await Promise.all(pending), ['cancelled', 'cancelled', 'cancelled']);
    assert.equal((await previewPdf(path, 1)).page, 1);
  } finally { await rm(work, { recursive: true, force: true }); }
});
