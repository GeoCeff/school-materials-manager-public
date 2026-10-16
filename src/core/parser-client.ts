import { connect } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ParserRequest } from './parser-process.js';

export async function runParserClient(pipe: string): Promise<void> {
  const nonce = process.env.SMM_PARSER_NONCE; delete process.env.SMM_PARSER_NONCE;
  if (!/^\\\\\.\\pipe\\archive-parser-[a-f0-9-]{36}$/.test(pipe) || !/^[a-f0-9]{64}$/.test(nonce ?? '')) throw new Error('Invalid parser transport.');
  const socket = connect(pipe);
  socket.on('error', () => {});
  const request = await new Promise<ParserRequest>((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    socket.once('error', reject); socket.once('end', () => reject(new Error('Parser transport closed.')));
    const receive = (chunk: Buffer) => {
      if (bytes.length + chunk.length > 64 * 1024) { socket.destroy(); reject(new Error('Parser request limit.')); return; }
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.at(-1) !== 10) return;
      socket.removeListener('data', receive);
      try {
        const value = JSON.parse(bytes.toString('utf8')) as ParserRequest;
        if (typeof value.filePath !== 'string' || value.filePath.length > 32768 || value.filePath.includes('\0') || typeof value.ocr !== 'boolean' ||
          (value.page !== undefined && (!Number.isSafeInteger(value.page) || value.page < 1 || value.page > 1000))) throw new Error('Invalid parser request.');
        resolve(value);
      } catch (error) { reject(error); }
    };
    socket.on('data', receive); socket.write(nonce + '\n');
  });
  // The guardian has already assigned this process to the Windows job before any parser import or file read.
  let message: unknown;
  try {
    const { extract, SourceError } = await import('./extract.js');
    try { message = { result: request.page === undefined ? await extract(request.filePath, undefined, request.ocr) : await (await import('./pdf.js')).renderPdfPage(request.filePath, request.page) }; }
    catch (error) { message = { error: error instanceof SourceError ? error.category : 'extraction-failed' }; }
  } catch { message = { error: 'extraction-failed' }; }
  let output = JSON.stringify(message);
  if (Buffer.byteLength(output) > 32 * 1024 ** 2) output = JSON.stringify({ error: 'parser-output-limit' });
  await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.end(output, resolve); });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) void runParserClient(process.argv[2] ?? '').then(() => process.exit(0), () => process.exit(1));
