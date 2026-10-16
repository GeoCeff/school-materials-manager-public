import { parentPort, workerData } from 'node:worker_threads';
import { extract, SourceError } from './extract.js';
const controller = new AbortController();
parentPort!.on('message', () => controller.abort());
try {
  const { filePath, page, ocr } = workerData as { filePath: string; page?: number; ocr: boolean };
  const result = page === undefined ? await extract(filePath, controller.signal, ocr) : await (await import('./pdf.js')).renderPdfPage(filePath, page);
  parentPort!.postMessage({ result });
}
catch (error) { parentPort!.postMessage({ error: error instanceof SourceError ? error.category : 'extraction-failed' }); }
