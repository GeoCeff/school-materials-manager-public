import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

test('native parser pipe rejects spoofed, truncated, multiple, disconnected and oversized responses; split framing works', { timeout: 45_000 }, async () => {
  // Copy only the already-built transport into a disposable sibling so its client can be adversarial.
  const compiled = fileURLToPath(new URL('../', import.meta.url));
  const work = await mkdtemp(join(compiled, 'parser-transport-'));
  const core = join(work, 'src', 'core'); await mkdir(core, { recursive: true }); await mkdir(join(work, 'assets'));
  try {
    for (const name of ['parser-process.js', 'windows.js', 'extract.js']) await copyFile(join(compiled, 'src', 'core', name), join(core, name));
    for (const name of ['parser-host.exe', 'parser-host.sha256']) await copyFile(join(compiled, 'assets', name), join(work, 'assets', name));
    const parser = await import(pathToFileURL(join(core, 'parser-process.js')).href) as { parseInProcess: (request: unknown) => Promise<unknown> };
    const result = { result: { status: 'indexed', source: { size: '1', modified: '2', inode: '3' }, passages: [{ text: 'safe marker', page: 1, startLine: null, endLine: null }] } };
    const client = (mode: string) => `import { connect } from 'node:net';
      const mode=${JSON.stringify(mode)},payload=${JSON.stringify(JSON.stringify(result))};
      const socket=connect(process.argv[2]); socket.on('error',()=>process.exit(0));
      socket.on('connect',()=>{
        if(mode==='bad-nonce'){socket.end('0'.repeat(64)+'\\n');return;}
        if(mode==='oversize-auth'){socket.end('x'.repeat(129)+'\\n');return;}
        const auth=process.env.SMM_PARSER_NONCE+'\\n';
        if(mode==='split') {socket.write(auth.slice(0,30));setTimeout(()=>socket.write(auth.slice(30)),10);}
        else socket.write(auth);
      });
      socket.once('data',()=>{
        if(mode==='disconnect'){socket.end();return;}
        if(mode==='truncated'){socket.end('{"result":');return;}
        if(mode==='multiple'){socket.end(payload+payload);return;}
        if(mode==='oversize'){for(let n=0;n<33;n++)socket.write(Buffer.alloc(1024*1024,32));socket.end();return;}
        if(mode==='split'){socket.write(payload.slice(0,20));setTimeout(()=>socket.end(payload.slice(20)),10);return;}
        socket.end(payload);
      }); socket.on('close',()=>process.exit(0));`;
    for (const mode of ['bad-nonce', 'oversize-auth', 'truncated', 'multiple', 'disconnect', 'oversize', 'split', 'valid']) {
      await writeFile(join(core, 'parser-client.js'), client(mode));
      if (mode === 'valid' || mode === 'split') assert.deepEqual(await parser.parseInProcess({ filePath: 'synthetic.pdf', ocr: false }), result.result);
      else await assert.rejects(parser.parseInProcess({ filePath: 'synthetic.pdf', ocr: false }), mode === 'oversize' ? /parser-output-limit/ : /invalid-parser-response/);
    }
  } finally { await rm(work, { recursive: true, force: true }); }
});
