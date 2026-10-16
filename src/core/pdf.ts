import { createCanvas, type Canvas, type SKRSContext2D } from '@napi-rs/canvas';
import { type PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { loadPdf, maxPdfImagePixels, readSource, SourceError } from './extract.js';

type CanvasEntry = { canvas: Canvas | null; context: SKRSContext2D | null };
export class BoundedCanvasFactory {
  private readonly allocations = new WeakMap<Canvas, number>();
  private pixels = 0;
  private dimensions(width: number, height: number, previous = 0) {
    width = Math.ceil(width); height = Math.ceil(height);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
      width > 8192 || height > 8192 || width * height > maxPdfImagePixels ||
      this.pixels - previous + width * height > maxPdfImagePixels * 4) throw new SourceError('pdf-render-limit');
    return { width, height, pixels: width * height };
  }
  create(width: number, height: number) {
    const size = this.dimensions(width, height);
    const canvas = createCanvas(size.width, size.height);
    this.allocations.set(canvas, size.pixels); this.pixels += size.pixels;
    return { canvas, context: canvas.getContext('2d') };
  }
  reset(entry: { canvas: Canvas | null }, width: number, height: number) {
    if (!entry.canvas) throw new SourceError('invalid-pdf');
    const previous = this.allocations.get(entry.canvas) ?? 0;
    const size = this.dimensions(width, height, previous);
    // Avoid a temporary new-width * old-height allocation during resizing.
    entry.canvas.width = entry.canvas.height = 0;
    entry.canvas.width = size.width; entry.canvas.height = size.height;
    this.allocations.set(entry.canvas, size.pixels); this.pixels += size.pixels - previous;
  }
  destroy(entry: CanvasEntry) {
    if (!entry.canvas) return;
    this.pixels -= this.allocations.get(entry.canvas) ?? 0;
    this.allocations.delete(entry.canvas);
    entry.canvas.width = entry.canvas.height = 0;
    entry.canvas = null; entry.context = null;
  }
}

export interface DocumentPage { image: string; page: number; pages: number; width: number; height: number }
export async function rasterize(page: PDFPageProxy, canvasFactory: object = new BoundedCanvasFactory()): Promise<{ png: Buffer; width: number; height: number }> {
  const base = page.getViewport({ scale: 1 });
  if (!Number.isFinite(base.width * base.height) || base.width <= 0 || base.height <= 0) throw new SourceError('invalid-pdf');
  const scale = Math.min(2, 2400 / base.width, 2400 / base.height, Math.sqrt(4_000_000 / (base.width * base.height)));
  const viewport = page.getViewport({ scale });
  const width = Math.max(1, Math.floor(viewport.width)); const height = Math.max(1, Math.floor(viewport.height));
  if (!(canvasFactory instanceof BoundedCanvasFactory)) throw new SourceError('invalid-pdf');
  const entry = canvasFactory.create(width, height);
  try {
    const render = page.render({ canvas: entry.canvas as unknown as HTMLCanvasElement, canvasContext: entry.context as unknown as CanvasRenderingContext2D, viewport });
    try {
      // Pinned PDF.js 6.4.299 can resolve rendering before rejecting its operator stream; observe both.
      const streams = [...page._intentStates.values()].flatMap(state => state.streamReader ? [state.streamReader.closed as Promise<void>] : []);
      if (!streams.length || streams.some(stream => !stream || typeof stream.then !== 'function')) throw new SourceError('invalid-pdf');
      await Promise.all([render.promise, ...streams]);
    } catch (error) {
      render.cancel(); await render.promise.catch(() => {});
      throw error;
    }
    return { png: entry.canvas.toBuffer('image/png'), width, height };
  } catch (error) {
    if (error instanceof SourceError) throw error;
    if (error instanceof Error && error.message.includes('Image exceeded maximum allowed size')) throw new SourceError('pdf-render-limit');
    throw new SourceError('invalid-pdf');
  } finally { canvasFactory.destroy(entry); }
}
export async function renderPdfPage(path: string, page: number): Promise<DocumentPage> {
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000) throw new SourceError('invalid-page');
  const { bytes } = await readSource(path, 32 * 1024 * 1024);
  const task = await loadPdf(bytes);
  try {
    const document = await task.promise;
    if (document.numPages > 1000 || page > document.numPages) throw new SourceError('invalid-page');
    const rendered = await rasterize(await document.getPage(page), document.canvasFactory);
    return { image: `data:image/png;base64,${rendered.png.toString('base64')}`, page, pages: document.numPages, width: rendered.width, height: rendered.height };
  } finally { await task.destroy(); }
}
