import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const source = new URL('native/parser-host.cs', root);
const output = new URL('dist/assets/parser-host.exe', root);
const manifest = new URL('dist/assets/parser-host.sha256', root);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceSha256 = digest(await readFile(source));
try {
  const saved = JSON.parse(await readFile(manifest, 'utf8'));
  if (saved.sourceSha256 === sourceSha256 && saved.sha256 === digest(await readFile(output))) process.exit(0);
} catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('The Windows x64 parser host must be built on Windows x64.');
await mkdir(new URL('dist/assets/', root), { recursive: true });
// Build-time compiler only; runtime parsing never discovers or invokes a compiler.
const compiler = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const result = spawnSync(compiler, ['/nologo', '/target:exe', '/platform:x64', '/optimize+', '/reference:System.Web.Extensions.dll', `/out:${fileURLToPath(output)}`, fileURLToPath(source)], { windowsHide: true, encoding: 'utf8', timeout: 30_000 });
if (result.error || result.status !== 0) throw new Error(`Parser host compilation failed: ${result.error?.message ?? result.stdout + result.stderr}`);
await writeFile(manifest, JSON.stringify({ sourceSha256, sha256: digest(await readFile(output)) }) + '\n');
