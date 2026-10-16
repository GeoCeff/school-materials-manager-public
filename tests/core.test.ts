import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Library, queryExpression } from '../src/core/library.js';
import { runSmoke, syntheticPdf } from '../src/smoke.js';

test('PDF/text/code retrieval, real locators, filename fallback, persistence, and read-only fixtures', async () => {
  const report = await runSmoke(tmpdir());
  assert.equal(report.queriesPassed, 18);
});

test('no-text PDF fixture paints an image without a text layer', async () => {
  const { getDocument, OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: new Uint8Array(syntheticPdf([null])) });
  try {
    const document = await task.promise;
    const page = await document.getPage(1);
    assert.equal((await page.getTextContent()).items.length, 0);
    assert.ok((await page.getOperatorList()).fnArray.some(operation => [OPS.paintImageXObject, OPS.paintInlineImageXObject].includes(operation)));
  } finally { await task.destroy(); }
});

test('query input is bounded and punctuation/operators remain literal', () => {
  assert.equal(queryExpression(' '), null);
  assert.equal(queryExpression('***'), null);
  assert.equal(queryExpression('alpha OR beta'), '"alpha" AND "OR" AND "beta"');
  assert.equal(queryExpression('"hello world" café'), '"hello world" AND "café"');
  assert.throws(() => queryExpression('"missing'), /Close/);
  assert.throws(() => queryExpression('x'.repeat(501)), /500/);
  assert.throws(() => queryExpression(Array(33).fill('word').join(' ')), /32/);
});

test('trust boundaries, failed replacement, atomic reindexing, encodings, and line limits', async () => {
  const work = await mkdtemp(join(tmpdir(), 'archive-boundaries-'));
  const root = join(work, 'archive');
  await mkdir(root);
  let library: Library | undefined;
  try {
    await assert.rejects(Library.open(root, join(root, 'index.sqlite')), /outside/);
    const database = join(work, 'library.sqlite');
    library = await Library.open(root, database);
    await writeFile(join(work, 'outside.txt'), 'Secret outside archive.');
    assert.equal((await library.indexFile('../outside.txt')).error, 'outside-root');
    assert.equal((await library.indexFile(join(work, 'outside.txt'))).error, 'outside-root');
    await mkdir(join(root, 'node_modules'));
    await writeFile(join(root, 'node_modules', 'hidden.txt'), 'Excluded package.');
    assert.equal((await library.indexFile('node_modules/hidden.txt')).error, 'excluded-path');
    await symlink(work, join(root, 'junction'), 'junction');
    assert.equal((await library.indexFile('junction/outside.txt')).error, 'linked-source');
    await symlink(root, join(work, 'alias'), 'junction');
    await assert.rejects(Library.open(root, join(work, 'alias', 'index.sqlite')), /outside/);
    await mkdir(join(work, 'other-root'));
    await assert.rejects(Library.open(join(work, 'other-root'), database), /another folder/);
    await writeFile(join(root, 'lecture.pdf'), syntheticPdf(['Earlier successful phrase.']));
    assert.equal((await library.indexFile('lecture.pdf')).status, 'indexed');
    await writeFile(join(root, 'lecture.pdf'), 'broken replacement');
    assert.equal((await library.indexFile('lecture.pdf')).status, 'stale');
    assert.equal(library.search('earlier successful')[0]!.status, 'stale');
    await writeFile(join(root, 'lecture.pdf'), syntheticPdf(['Replacement successful phrase.']));
    await library.indexFile('lecture.pdf');
    await library.indexFile('lecture.pdf');
    assert.equal(library.search('earlier').length, 0);
    assert.equal(library.search('replacement')[0]!.matchCount, 1);
    await writeFile(join(root, 'binary.txt'), Buffer.from([0, 1, 2]));
    assert.equal((await library.indexFile('binary.txt')).error, 'binary-content');
    await writeFile(join(root, 'encoding.txt'), Buffer.from([0xc3, 0x28]));
    assert.equal((await library.indexFile('encoding.txt')).error, 'unsupported-encoding');
    await writeFile(join(root, 'utf16.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Readable Unicode sample.', 'utf16le')]));
    assert.equal((await library.indexFile('utf16.txt')).status, 'indexed');
    await writeFile(join(root, 'lines.txt'), Array.from({ length: 81 }, (_, index) => index === 80 ? 'finalneedle' : 'line').join('\n'));
    await library.indexFile('lines.txt');
    assert.equal(library.search('finalneedle')[0]!.startLine, 81);
    await writeFile(join(root, 'large.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 65));
    assert.equal((await library.indexFile('large.txt')).error, 'size-limit');
    await writeFile(join(root, 'script.html'), '<script>alert(1)</script>');
    assert.equal((await library.indexFile('script.html')).error, 'unsupported-type');
    assert.equal(library.search('OR * : ""').length, 0);
  } finally { library?.close(); await rm(work, { recursive: true, force: true }); }
});
