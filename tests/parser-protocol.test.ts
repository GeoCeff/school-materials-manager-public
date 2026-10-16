import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateParserResult } from '../src/core/parser-process.js';
import { createCanvas } from '@napi-rs/canvas';

const request = { filePath: 'synthetic.pdf', ocr: false };
test('the parser process cannot return malformed or unbounded extracted data', () => {
  const valid = { status: 'indexed', source: { size: '100', modified: '20', inode: '30' }, passages: [{ text: 'safe embedded text', page: 2, startLine: null, endLine: null, origin: 'embedded' }] };
  assert.deepEqual(validateParserResult(valid, request), valid);
  for (const data of [null, {}, { ...valid, status: 'unknown' }, { ...valid, limitation: 'arbitrary' }, { ...valid, source: { ...valid.source, size: 'NaN' } },
    { ...valid, passages: [{ ...valid.passages[0], text: 'x'.repeat(4001) }] }, { ...valid, passages: [{ ...valid.passages[0], page: 0 }] },
    { ...valid, passages: Array(501).fill({ ...valid.passages[0], text: 'x'.repeat(4000) }) }, { ...valid, status: 'no-text' }]) {
    assert.throws(() => validateParserResult(data, request), /invalid-parser-response/);
  }
});
test('the parser preview response must match requested page and bounded actual PNG dimensions', () => {
  const canvas = createCanvas(2, 2);
  const valid = { page: 1, pages: 2, width: 2, height: 2, image: canvas.toDataURL('image/png') };
  try {
    const pageRequest = { ...request, page: 1 };
    assert.deepEqual(validateParserResult(valid, pageRequest), valid);
    for (const data of [{ ...valid, page: 2 }, { ...valid, pages: 0 }, { ...valid, width: 2001, height: 2000 }, { ...valid, width: 3 }, { ...valid, image: 'data:image/png;base64,AAAA' }]) {
      assert.throws(() => validateParserResult(data, pageRequest), /invalid-parser-response/);
    }
  } finally { canvas.width = canvas.height = 0; }
});
