import { open } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, join } from 'node:path';
import { Worker } from 'node:worker_threads';

export interface Passage {
  text: string;
  page: number | null;
  startLine: number | null;
  endLine: number | null;
  origin?: string;
}

export class SourceError extends Error {
  constructor(public readonly category: string) { super(category); }
}

export const supportedExtensions = new Set(['.pdf', '.docx', '.pptx', '.md', '.txt', '.c', '.h', '.cpp', '.py', '.kt', '.js', '.ts']);
const maxCharacters = 2_000_000;
const passageCharacters = 4_000;
const pdfAssets = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
export const maxPdfImagePixels = 4_000_000;

export interface Extraction {
  passages: Passage[];
  status: 'indexed' | 'partial' | 'no-text';
  limitation?: 'pdf-render-limit';
  source: { size: string; modified: string; inode: string };
}

function sourceWorker<T>(filePath: string, signal?: AbortSignal, ocr = false, page?: number): Promise<T> {
  if (extname(filePath).toLowerCase() === '.pdf') {
    if (process.platform !== 'win32') return Promise.reject(new SourceError('parser-containment-unavailable'));
    return import('./parser-process.js').then(({ parseInProcess }) => parseInProcess({ filePath, ocr, ...(page !== undefined ? { page } : {}) }, signal)) as Promise<T>;
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new SourceError('cancelled')); return; }
    const worker = new Worker(new URL('./extraction-worker.js', import.meta.url), { workerData: { filePath, ocr, page }, execArgv: [] });
    let settled = false;
    const finish = (error?: Error, result?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', cancel);
      if (error) { worker.postMessage('cancel'); setTimeout(() => void worker.terminate(), 150).unref(); }
      else void worker.terminate();
      if (error) reject(error); else resolve(result!);
    };
    const cancel = () => finish(new SourceError('cancelled'));
    const timeout = setTimeout(() => finish(new SourceError('extraction-timeout')), ocr ? 120_000 : 30_000);
    signal?.addEventListener('abort', cancel, { once: true });
    worker.on('message', (message: { result?: T; error?: string }) => finish(message.error ? new SourceError(message.error) : undefined, message.result));
    worker.on('error', () => finish(new SourceError('extraction-failed')));
    worker.on('exit', () => { if (!settled) finish(new SourceError('extraction-interrupted')); });
  });
}

export const extractBounded = (filePath: string, signal?: AbortSignal, ocr = false) => sourceWorker<Extraction>(filePath, signal, ocr);
export const previewPdf = (filePath: string, page: number, signal?: AbortSignal) => !Number.isSafeInteger(page) || page < 1 || page > 1000
  ? Promise.reject(new SourceError('invalid-page')) : sourceWorker<import('./pdf.js').DocumentPage>(filePath, signal, false, page);

export async function readSource(filePath: string, maxBytes: number) {
  const handle = await open(filePath, 'r');
  let bytes: Buffer;
  let source: Extraction['source'];
  try {
    const before = await handle.stat({ bigint: true });
    if (before.size > BigInt(maxBytes)) throw new SourceError('size-limit');
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (length > Number(before.size) || before.size !== after.size || before.mtimeNs !== after.mtimeNs) throw new SourceError('changed-during-extraction');
    bytes = buffer.subarray(0, length);
    source = { size: before.size.toString(), modified: before.mtimeNs.toString(), inode: before.ino.toString() };
  } finally { await handle.close(); }
  return { bytes, source };
}

export async function loadPdf(bytes: Buffer) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { BoundedCanvasFactory } = await import('./pdf.js');
  return getDocument({ data: new Uint8Array(bytes), useSystemFonts: false,
    maxImageSize: maxPdfImagePixels, canvasMaxAreaInBytes: maxPdfImagePixels * 4,
    stopAtErrors: true, CanvasFactory: BoundedCanvasFactory,
    standardFontDataUrl: join(pdfAssets, 'standard_fonts').replaceAll('\\', '/') + '/',
    cMapUrl: join(pdfAssets, 'cmaps').replaceAll('\\', '/') + '/', cMapPacked: true,
    wasmUrl: join(pdfAssets, 'wasm').replaceAll('\\', '/') + '/' });
}

export async function extract(filePath: string, signal?: AbortSignal, ocr = false): Promise<Extraction> {
  const extension = extname(filePath).toLowerCase();
  if (!supportedExtensions.has(extension)) throw new SourceError('unsupported-type');
  const { bytes, source } = await readSource(filePath, (['.pdf', '.docx', '.pptx'].includes(extension) ? 32 : 2) * 1024 * 1024);
  const passages: Passage[] = [];
  if (['.docx', '.pptx'].includes(extension)) {
    const { extractOffice } = await import('./office.js');
    const passages = await extractOffice(bytes, extension, signal);
    return { passages, source, status: passages.length ? 'indexed' : 'no-text' };
  }
  if (extension !== '.pdf') {
    let text: string;
    try {
      const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
        : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
      text = new TextDecoder(encoding, { fatal: true }).decode(bytes).replace(/\r\n?/g, '\n');
    } catch { throw new SourceError('unsupported-encoding'); }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text)) throw new SourceError('binary-content');
    if (text.length > maxCharacters) throw new SourceError('text-limit');
    const lines = text.split('\n');
    let start = 0;
    while (start < lines.length) {
      let end = start + 1;
      let length = lines[start]!.length;
      while (end < lines.length && end - start < 80 && length + lines[end]!.length + 1 <= passageCharacters) {
        length += lines[end]!.length + 1;
        end++;
      }
      const block = lines.slice(start, end).join('\n');
      // ponytail: phrases stay within 4,000-character passages; add measured overlap if boundary misses matter.
      for (let offset = 0; offset < block.length; offset += passageCharacters) {
        const part = block.slice(offset, offset + passageCharacters);
        if (part.trim()) passages.push({ text: part, page: null, startLine: start + 1, endLine: end });
      }
      start = end;
    }
    return { passages, source, status: passages.length ? 'indexed' : 'no-text' };
  }
  const task = await loadPdf(bytes);
  try {
    const document = await task.promise;
    if (document.numPages < 1) throw new SourceError('invalid-pdf');
    if (document.numPages > 1_000) throw new SourceError('page-limit');
    let emptyPages = 0;
    let characters = 0;
    let ocrPages = 0;
    let limitedPages = 0;
    for (let page = 1; page <= document.numPages; page++) {
      const sourcePage = await document.getPage(page);
      const content = await sourcePage.getTextContent();
      let text = content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').trim();
      let origin = 'embedded';
      if (!text && ocr && ocrPages < 20) {
        signal?.throwIfAborted(); ocrPages++;
        const { rasterize } = await import('./pdf.js'); const { recognizeImage } = await import('./ocr.js');
        try {
          const recognized = await recognizeImage((await rasterize(sourcePage, document.canvasFactory)).png, signal);
          text = recognized.text.trim(); origin = `ocr:${recognized.language}`;
        } catch (error) {
          if (!(error instanceof SourceError) || error.category !== 'pdf-render-limit') throw error;
          limitedPages++;
        }
      }
      sourcePage.cleanup();
      characters += text.length;
      if (characters > maxCharacters) throw new SourceError('text-limit');
      if (!text) emptyPages++;
      for (let offset = 0; offset < text.length; offset += passageCharacters) {
        passages.push({ text: text.slice(offset, offset + passageCharacters), page, startLine: null, endLine: null, origin });
      }
    }
    return { passages, source, status: !passages.length ? 'no-text' : emptyPages ? 'partial' : 'indexed',
      ...(limitedPages ? { limitation: 'pdf-render-limit' as const } : {}) };
  } catch (error) {
    if (error instanceof SourceError) throw error;
    throw new SourceError(error instanceof Error && error.name === 'PasswordException' ? 'encrypted-pdf' : 'invalid-pdf');
  } finally { await task.destroy(); }
}
