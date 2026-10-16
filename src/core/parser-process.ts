import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { SourceError, type Extraction } from './extract.js';
import type { DocumentPage } from './pdf.js';
import { nativeEnvironment } from './windows.js';

export interface ParserRequest { filePath: string; ocr: boolean; page?: number }
export const parserLimits = Object.freeze({ processBytes: 384 * 1024 ** 2, jobBytes: 512 * 1024 ** 2, responseBytes: 32 * 1024 ** 2 });
let active = 0;
const waiting: (() => void)[] = [];
function acquire(signal?: AbortSignal): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const abort = () => { const index = waiting.indexOf(grant); if (index >= 0) waiting.splice(index, 1); reject(new SourceError('cancelled')); };
    const grant = () => {
      signal?.removeEventListener('abort', abort); active++;
      resolve(() => { active--; waiting.shift()?.(); });
    };
    if (signal?.aborted) { reject(new SourceError('cancelled')); return; }
    if (active < 2) grant(); else { waiting.push(grant); signal?.addEventListener('abort', abort, { once: true }); }
  });
}
async function supervisorPath(): Promise<string> {
  const logical = fileURLToPath(new URL('../../assets/parser-host.exe', import.meta.url));
  const physical = logical.replace(/\.asar([\\/])/, '.asar.unpacked$1');
  const manifest = JSON.parse(await readFile(new URL('../../assets/parser-host.sha256', import.meta.url), 'utf8')) as { sha256: string };
  const info = await lstat(physical);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024 || !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
    createHash('sha256').update(await readFile(physical)).digest('hex') !== manifest.sha256) throw new SourceError('parser-containment-unavailable');
  return physical;
}

export function validateParserResult(value: unknown, request: ParserRequest): Extraction | DocumentPage {
  if (!value || typeof value !== 'object') throw new SourceError('invalid-parser-response');
  const data = value as Record<string, any>;
  const integer = (n: unknown, max: number) => Number.isSafeInteger(n) && Number(n) >= 1 && Number(n) <= max;
  if (request.page !== undefined) {
    if (data.page !== request.page || !integer(data.pages, 1000) || data.pages < data.page || !integer(data.width, 8192) || !integer(data.height, 8192) || data.width * data.height > 4_000_000 ||
      typeof data.image !== 'string' || !data.image.startsWith('data:image/png;base64,') || data.image.length > parserLimits.responseBytes) throw new SourceError('invalid-parser-response');
    const png = Buffer.from(data.image.slice(22), 'base64');
    if (png.length < 24 || !png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || png.readUInt32BE(16) !== data.width || png.readUInt32BE(20) !== data.height) throw new SourceError('invalid-parser-response');
    return { image: data.image, page: data.page, pages: data.pages, width: data.width, height: data.height };
  }
  if (!['indexed', 'partial', 'no-text'].includes(data.status) || !Array.isArray(data.passages) || data.passages.length > 10_000 ||
    (data.limitation !== undefined && data.limitation !== 'pdf-render-limit') || !data.source ||
    !['size', 'modified', 'inode'].every(key => typeof data.source[key] === 'string' && /^-?\d{1,40}$/.test(data.source[key]))) throw new SourceError('invalid-parser-response');
  let characters = 0;
  for (const passage of data.passages) {
    if (!passage || typeof passage.text !== 'string' || passage.text.length > 4000 || (characters += passage.text.length) > 2_000_000 ||
      !integer(passage.page, 1000) || passage.startLine !== null || passage.endLine !== null ||
      (passage.origin !== undefined && (typeof passage.origin !== 'string' || passage.origin.length > 100))) throw new SourceError('invalid-parser-response');
  }
  if ((data.status === 'no-text') !== (data.passages.length === 0)) throw new SourceError('invalid-parser-response');
  return { passages: data.passages, source: { size: data.source.size, modified: data.source.modified, inode: data.source.inode }, status: data.status,
    ...(data.limitation ? { limitation: data.limitation } : {}) };
}

export async function parseInProcess(request: ParserRequest, signal?: AbortSignal): Promise<Extraction | DocumentPage> {
  const release = await acquire(signal);
  try { return await execute(request, signal); } finally { release(); }
}
async function execute(request: ParserRequest, signal?: AbortSignal): Promise<Extraction | DocumentPage> {
  let executable: string;
  try { executable = await supervisorPath(); } catch { throw new SourceError('parser-containment-unavailable'); }
  if (signal?.aborted) throw new SourceError('cancelled');
  const pipe = `\\\\.\\pipe\\archive-parser-${randomUUID()}`;
  const nonce = randomBytes(32).toString('hex');
  const sockets = new Set<Socket>(); let connected = false;
  let accept!: (value: unknown) => void; let refuse!: (error: Error) => void;
  const response = new Promise<unknown>((resolve, reject) => { accept = resolve; refuse = reject; });
  void response.catch(() => {});
  const server = createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    let authenticated = false; let size = 0; const chunks: Buffer[] = [];
    const handshakeTimer = setTimeout(() => socket.destroy(), 1000);
    socket.once('close', () => clearTimeout(handshakeTimer));
    socket.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > parserLimits.responseBytes) { refuse(new SourceError('parser-output-limit')); socket.destroy(); return; }
      if (!authenticated) {
        if (size > 128) { socket.destroy(); return; }
        chunks.push(chunk); const bytes = Buffer.concat(chunks); const end = bytes.indexOf(10);
        if (end < 0) { if (size > 128) socket.destroy(); return; }
        const supplied = bytes.subarray(0, end);
        if (connected || supplied.length !== nonce.length || !timingSafeEqual(supplied, Buffer.from(nonce)) || end !== bytes.length - 1) { socket.destroy(); return; }
        connected = authenticated = true; clearTimeout(handshakeTimer); size = 0; chunks.length = 0;
        socket.write(JSON.stringify(request) + '\n');
      } else chunks.push(chunk);
    });
    socket.on('end', () => {
      clearTimeout(handshakeTimer);
      if (authenticated) { try { accept(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { refuse(new SourceError('invalid-parser-response')); } }
    });
  });
  server.maxConnections = 4;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(pipe, resolve); });
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const args = process.versions.electron ? [...(/\.asar[\\/]?$/.test(root) ? [] : [root]), '--archive-parser', pipe]
    : [fileURLToPath(new URL('./parser-client.js', import.meta.url)), pipe];
  const env: NodeJS.ProcessEnv = { ...nativeEnvironment(), SMM_PARSER_NONCE: nonce };
  const child = spawn(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env });
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  child.stdin.on('error', () => {}); child.stderr.resume();
  const timeoutMs = request.ocr ? 120_000 : 30_000;
  child.stdin.write(JSON.stringify({ executable: process.execPath, args, processBytes: parserLimits.processBytes, jobBytes: parserLimits.jobBytes, timeoutMs }) + '\n');
  const cancel = () => { refuse(new SourceError('cancelled')); child.stdin.end(); child.kill(); };
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timeout = setTimeout(() => { refuse(new SourceError('extraction-timeout')); child.stdin.end(); child.kill(); }, timeoutMs + 3000);
  let report = ''; let reportOversized = false;
  child.stdout.on('data', (chunk: Buffer) => { if (report.length + chunk.length > 4096) { reportOversized = true; child.kill(); } else report += chunk.toString('utf8'); });
  const exited = new Promise<void>((resolve, reject) => {
    child.on('error', () => reject(new SourceError('parser-containment-unavailable')));
    child.on('close', code => {
      try {
        const status = JSON.parse(report);
        if (reportOversized || !status.assigned) throw new SourceError('parser-containment-unavailable');
        if (status.status === 'resource-limit') throw new SourceError('extraction-resource-limit');
        if (status.status === 'timeout') throw new SourceError('extraction-timeout');
        if (status.status !== 'completed' || code !== 0 || status.code !== 0) throw new SourceError('extraction-interrupted');
        if (!connected) throw new SourceError('invalid-parser-response');
        resolve();
      } catch (error) { reject(error instanceof SourceError ? error : new SourceError('parser-containment-unavailable')); }
    });
  });
  try {
    const [message] = await Promise.all([response, exited]);
    const payload = message as { result?: unknown; error?: string };
    if (payload?.error) {
      const categories = new Set(['invalid-pdf', 'invalid-page', 'encrypted-pdf', 'pdf-render-limit', 'size-limit', 'page-limit', 'text-limit', 'changed-during-extraction', 'ocr-unavailable', 'ocr-timeout', 'cancelled']);
      throw new SourceError(categories.has(payload.error) ? payload.error : 'extraction-failed');
    }
    return validateParserResult(payload?.result, request);
  } finally {
    clearTimeout(timeout); signal?.removeEventListener('abort', cancel); child.stdin.end(); child.kill();
    await closed;
    for (const socket of sockets) socket.destroy(); server.close();
  }
}
