import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Library } from './core/library.js';
import { ArchiveService } from './core/index.js';
import { createCanvas } from '@napi-rs/canvas';
import { syntheticDocx, syntheticPptx } from './office-fixtures.js';

// Original synthetic PDFs keep the dependency experiment repeatable without private school material.
export function syntheticPdf(pages: (string | null)[], scan?: { width: number; height: number; jpeg: Buffer }): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const imageId = 4 + pages.length * 2;
  for (const text of pages) {
    const pageId = objects.length + 1;
    const lines = (text?.match(/.{1,75}(?:\s|$)|\S+/g) ?? []).map(line => line.trim().replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)'));
    const stream = text === null ? (scan ? `q 512 0 0 ${512 * scan.height / scan.width} 50 500 cm /Scan Do Q` : 'q 220 0 0 220 50 480 cm /Scan Do Q') : text ? `BT /F1 12 Tf 16 TL 50 750 Td ${lines.map(line => `(${line}) Tj T*`).join(' ')} ET` : '';
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> ${text === null ? `/XObject << /Scan ${imageId} 0 R >>` : ''} >> /Contents ${pageId + 1} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  // A null page paints a real image with no text layer; empty strings remain blank-page fixtures.
  if (pages.includes(null)) objects.push(scan ? `<< /Type /XObject /Subtype /Image /Width ${scan.width} /Height ${scan.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter [/ASCIIHexDecode /DCTDecode] /Length ${scan.jpeg.length * 2 + 1} >>\nstream\n${scan.jpeg.toString('hex')}>\nendstream` : '<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 9 >>\nstream\n00FFFF00>\nendstream');
  let document = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(document));
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(document);
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  document += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(document);
}

export function syntheticScan(): Buffer {
  const canvas = createCanvas(1500, 240); const context = canvas.getContext('2d');
  context.fillStyle = '#fff'; context.fillRect(0, 0, 1500, 240); context.fillStyle = '#000'; context.font = '64px Arial'; context.fillText('LUNAR TELESCOPE 2042', 70, 130);
  return syntheticPdf([null], { width: 1500, height: 240, jpeg: canvas.toBuffer('image/jpeg') });
}

export async function runSmoke(dataDirectory: string) {
  await mkdir(dataDirectory, { recursive: true });
  const work = await mkdtemp(join(dataDirectory, 'compatibility-'));
  const root = join(work, 'synthetic-archive');
  await mkdir(join(root, 'other'), { recursive: true });
  const fixtures = new Map<string, string | Buffer>([
    ['recognition.pdf', syntheticScan()],
    ['observatory.docx', syntheticDocx(['Lunar telescope calibration.'])],
    ['observatory.pptx', syntheticPptx(['Introduction', 'Orbital momentum demonstration.'])],
    ['lecture.pdf', syntheticPdf(['Binary search trees organize keys.', 'Conservation of energy connects kinetic and potential energy.'])],
    ['notes.md', '# Study notes\nCafé résumé and Unicode notes.\nA priority queue stores pending tasks.\n<x-script>inert markup</x-script>'],
    ['algorithm.cpp', '// Sample algorithm\nint countStudyPages() { return 8; }\nint student_count = 3;'],
    ['notes.txt', 'A sorting algorithm reorders values.\nThe AND operator is a word here.'],
    ['other/notes.md', 'A telescope observes distant stars.'],
    ['scanned.pdf', syntheticPdf([null])],
    ['mixed.pdf', syntheticPdf(['Sparse searchable heading.', null])],
    ['broken.pdf', 'This is not a PDF.'],
  ]);
  const fingerprints = new Map<string, string>();
  const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  for (const [path, content] of fixtures) {
    await writeFile(join(root, path), content);
    fingerprints.set(path, digest(await readFile(join(root, path))));
  }
  const databasePath = join(work, 'library.sqlite');
  let library: Library | undefined;
  try {
    library = await Library.open(root, databasePath);
    const outcomes = [];
    for (const path of fixtures.keys()) outcomes.push({ path, ...await library.indexFile(path) });
    assert.equal(outcomes.find(row => row.path === 'scanned.pdf')!.status, 'no-text', JSON.stringify(outcomes));
    assert.equal(outcomes.find(row => row.path === 'mixed.pdf')!.status, 'partial');
    assert.equal(outcomes.find(row => row.path === 'broken.pdf')!.error, 'invalid-pdf');
    library.close();
    library = await Library.open(root, databasePath);
    const queries: { query: string; path?: string; page?: number; line?: number }[] = [
      { query: 'lunar calibration', path: 'observatory.docx', line: 1 },
      { query: 'orbital momentum', path: 'observatory.pptx', page: 2 },
      { query: 'binary trees', path: 'lecture.pdf', page: 1 },
      { query: '"binary search trees"', path: 'lecture.pdf', page: 1 },
      { query: '"conservation of energy"', path: 'lecture.pdf', page: 2 },
      { query: 'kinetic potential', path: 'lecture.pdf', page: 2 },
      { query: 'priority queue', path: 'notes.md', line: 1 },
      { query: 'café résumé', path: 'notes.md', line: 1 },
      { query: 'countStudyPages', path: 'algorithm.cpp', line: 1 },
      { query: 'student_count', path: 'algorithm.cpp', line: 1 },
      { query: 'algorithm.cpp', path: 'algorithm.cpp', line: 1 },
      { query: 'sorting algorithm', path: 'notes.txt', line: 1 },
      { query: 'AND', path: 'notes.txt', line: 1 },
      { query: 'telescope', path: 'other/notes.md', line: 1 },
      { query: 'scanned.pdf', path: 'scanned.pdf' },
      { query: 'sparse searchable', path: 'mixed.pdf', page: 1 },
      { query: 'unfindablequasar' },
    ];
    const timings = [];
    for (const check of queries) {
      const start = performance.now();
      const matches = library.search(check.query);
      timings.push(performance.now() - start);
      if (!check.path) assert.equal(matches.length, 0);
      else {
        const found = matches.slice(0, 5).find(row => row.relativePath.replaceAll('\\', '/') === check.path);
        assert.ok(found, `Expected source for ${check.query}`);
        if (check.page) assert.equal(found.page, check.page);
        if (check.line) assert.equal(found.startLine, check.line);
        if (check.query === 'scanned.pdf' || check.query === 'algorithm.cpp') assert.equal(found.filenameOnly, true);
      }
    }
    assert.ok(library.search('inert markup')[0]!.text.includes('<x-script>'));
    let service = new ArchiveService(join(work, 'service-data'));
    let importJob;
    try {
      await service.init(); await service.prepareRoot(root); await service.start('import'); importJob = await service.whenIdle();
      assert.equal(importJob!.state, 'completed'); assert.equal(importJob!.processed, fixtures.size); assert.equal(importJob!.counts.failed, 1);
      assert.equal(service.search('"conservation of energy"', {}, 0).results[0]!.page, 2);
      const passage = service.search('priority queue', {}, 0).results[0]!;
      await service.saveSearch('priority queue', {}); await service.saveBookmark(passage.fileId, passage.passageId);
      await service.setTheme('dark'); await service.close();
      service = new ArchiveService(join(work, 'service-data')); await service.init();
      const bookmark = (await service.saved()).find(item => item.kind === 'bookmark')!;
      assert.match((await service.openBookmark(bookmark.id)).text, /priority queue/); assert.equal((await service.saved()).length, 2);
      assert.equal((await service.status()).theme, 'dark'); assert.equal(service.search('priority queue', {}, 0).total, 1);
      const browsed = await service.browse({ folder: 'other', inventory: 'indexed', filters: {}, offset: 0 });
      assert.equal(browsed.entries[0]!.name, 'notes.md');
      const browsedFile = browsed.entries[0]!;
      assert.equal(browsedFile.kind, 'file');
      if (browsedFile.kind === 'file') assert.ok((await service.preview(browsedFile.fileId!, browsedFile.passageId!)).text.includes('telescope'));
      await mkdir(join(root, 'empty'));
      await writeFile(join(root, 'unindexed.txt'), 'Read-only inventory sample.');
      await writeFile(join(root, 'unsupported.zip'), Buffer.from('504b0506000000000000000000000000000000000000', 'hex'));
      const inventory = await service.browse({ folder: '', inventory: 'all', filters: { type: 'PDF' }, offset: 0 });
      assert.ok(inventory.entries.some(entry => entry.kind === 'folder' && entry.name === 'empty'));
      assert.ok(inventory.entries.some(entry => entry.kind === 'file' && entry.status === 'not-indexed'));
      assert.ok(inventory.entries.some(entry => entry.kind === 'file' && entry.status === 'unsupported'));
      await assert.rejects(service.resolveEntry(root, '../outside.txt'));
      await rm(join(root, 'unindexed.txt')); await rm(join(root, 'unsupported.zip'));
      await service.start('refresh'); const refresh = await service.whenIdle();
      assert.equal(refresh!.counts.unchanged, fixtures.size - 1); assert.equal(refresh!.counts.failed, 1);
      await service.setOcr(true); await service.start('refresh'); await service.whenIdle();
      const recognized = service.search('2042', {}, 0).results[0]!;
      assert.equal(recognized.relativePath, 'recognition.pdf'); assert.match(recognized.origin!, /^ocr:/); assert.equal(recognized.page, 1);
      const rendered = await service.document(recognized.fileId, 1); assert.match(rendered.image, /^data:image\/png;base64,/); assert.equal(rendered.pages, 1);
    } finally { await service.close(); }
    for (const [path, fingerprint] of fingerprints) assert.equal(digest(await readFile(join(root, path))), fingerprint);
    return {
      passed: true,
      runtime: { node: process.versions.node, electron: process.versions.electron ?? null },
      sqlite: 'FTS5 available; index reopened successfully',
      files: fixtures.size,
      queriesPassed: queries.length + 1,
      sourceHashesUnchanged: true,
      serviceLifecycle: { imported: importJob!.processed, restarted: true, themePersisted: true, unchangedRefresh: fixtures.size - 1 },
      fileNavigation: { indexedHierarchy: true, storedPreview: true, liveInventory: true, guardedReveal: true },
      releaseFeatures: { officeLocators: true, savedItemsRestart: true, offlineOcr: true, pdfPageRendering: true },
      queryMilliseconds: { max: Math.max(...timings), median: [...timings].sort((a, b) => a - b)[Math.floor(timings.length / 2)] },
      outcomes,
    };
  } finally {
    library?.close();
    await rm(work, { recursive: true, force: true });
  }
}
