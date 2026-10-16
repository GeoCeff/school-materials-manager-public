import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { windowsTask } from '../src/core/windows.js';

const host = fileURLToPath(new URL('../assets/parser-host.exe', import.meta.url));
const windows = { skip: process.platform !== 'win32' || process.arch !== 'x64' };
const mib = 1024 * 1024;
interface Report { status: string; code: number; pid: number; assigned: boolean; peakProcessBytes: number; peakJobBytes: number }
function launch(args: string[], options: { processMiB?: number; jobMiB?: number; timeoutMs?: number; raw?: string } = {}) {
  const child = spawn(host, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {}); child.stderr.resume();
  const report = new Promise<Report>((resolve, reject) => {
    let output = ''; const timeout = setTimeout(() => { child.kill(); reject(new Error('Parser supervisor test timed out.')); }, 12_000);
    child.stdout.setEncoding('utf8'); child.stdout.on('data', (part: string) => {
      output += part; if (output.length > 4096) { child.kill(); reject(new Error('Supervisor output exceeded its contract.')); }
    });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', code => {
      clearTimeout(timeout);
      try { const result = JSON.parse(output.trim()) as Report; assert.equal(code, result.status === 'completed' && result.code === 0 ? 0 : 1); resolve(result); }
      catch (error) { reject(error); }
    });
  });
  const config = { executable: process.execPath, args, processBytes: (options.processMiB ?? 256) * mib, jobBytes: (options.jobMiB ?? 320) * mib, timeoutMs: options.timeoutMs ?? 5000 };
  child.stdin.write(options.raw ?? JSON.stringify(config) + '\n');
  return { child, report };
}
const pause = () => new Promise(resolve => setTimeout(resolve, 40));
async function marker(path: string): Promise<string> {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) { try { return await readFile(path, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } await pause(); }
  throw new Error('Bounded test child did not start.');
}
async function gone(pid: number) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) { try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; throw error; } await pause(); }
  assert.fail(`Contained process ${pid} survived supervisor cleanup.`);
}

test('native parser host matches its recorded compiled digest and source digest', windows, async () => {
  const manifest = JSON.parse(await readFile(new URL('../assets/parser-host.sha256', import.meta.url), 'utf8')) as { sourceSha256: string; sha256: string };
  assert.equal(createHash('sha256').update(await readFile(host)).digest('hex'), manifest.sha256);
  assert.equal(createHash('sha256').update(await readFile(new URL('../../native/parser-host.cs', import.meta.url))).digest('hex'), manifest.sourceSha256);
});

test('native parser job rejects committed Buffer allocations and then runs a valid child', windows, async t => {
  const work = await mkdtemp(join(tmpdir(), 'archive-host-memory-'));
  try {
    for (const processMiB of [64, 96]) {
      const path = join(work, `progress-${processMiB}.txt`);
      const script = `const fs=require('fs'),blocks=[];fs.writeFileSync(process.argv[1],'0');for(let i=0;i<32;i++){blocks.push(Buffer.alloc(8*1024*1024,0xa5));fs.writeFileSync(process.argv[1],String((i+1)*8));}`;
      const run = launch(['-e', script, path], { processMiB, jobMiB: processMiB + 32 });
      const result = await run.report;
      assert.equal(result.status, 'resource-limit'); assert.equal(result.assigned, true); assert.notEqual(result.code, 0);
      const allocatedMiB = Number(await readFile(path, 'utf8'));
      assert.ok(allocatedMiB < 256); assert.ok(allocatedMiB >= 8, 'probe must reach actual committed Buffer allocation');
      assert.ok(result.peakProcessBytes > 0 && result.peakProcessBytes <= processMiB * mib);
      assert.ok(result.peakJobBytes > 0 && result.peakJobBytes <= (processMiB + 32) * mib);
      await gone(result.pid); t.diagnostic(JSON.stringify({ processMiB, allocatedMiB, ...result }));
    }
    const normal = await launch(['-e', 'process.exit(0)']).report;
    assert.equal(normal.status, 'completed'); assert.equal(normal.code, 0); assert.equal(normal.assigned, true);
  } finally { await rm(work, { recursive: true, force: true }); }
});

test('native parser host quotes every Windows argument without a shell', windows, async () => {
  const work = await mkdtemp(join(tmpdir(), 'archive host quoting '));
  try {
    const path = join(work, 'arguments.json'); const args = ['', 'space here', 'trailing\\', 'embedded"quote', 'backslash\\"quote', 'C:\\Program Files\\folder\\', 'Unicode 日本語'];
    const result = await launch(['-e', `require('fs').writeFileSync(process.argv[1],JSON.stringify(process.argv.slice(2)))`, path, ...args]).report;
    assert.equal(result.status, 'completed'); assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), args);
  } finally { await rm(work, { recursive: true, force: true }); }
});

test('native parser job also limits aggregate committed memory across descendants', windows, async t => {
  const work = await mkdtemp(join(tmpdir(), 'archive-host-job-memory-'));
  try {
    const path = join(work, 'child-progress.txt'); const pidPath = join(work, 'child-pid.txt');
    const allocate = `const blocks=[];for(let i=0;i<24;i++){blocks.push(Buffer.alloc(8*1024*1024,0xa5));require('fs').writeFileSync(process.argv[1],String((i+1)*8));}setInterval(()=>{},1000);`;
    const script = `const held=Buffer.alloc(64*1024*1024,0xa5);const child=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(allocate)},process.argv[1]],{stdio:'ignore'});require('fs').writeFileSync(process.argv[2],String(child.pid));setInterval(()=>{held[0]^=1},1000);`;
    const result = await launch(['-e', script, path, pidPath], { processMiB: 128, jobMiB: 160 }).report;
    t.diagnostic(JSON.stringify(result));
    assert.equal(result.status, 'resource-limit'); assert.equal(result.assigned, true);
    assert.ok(Number(await readFile(path, 'utf8')) >= 8);
    assert.ok(result.peakProcessBytes < 128 * mib, 'neither process should reach its individual ceiling');
    // Windows peak accounting can exceed the configured allocation limit; bound this probe independently.
    assert.ok(result.peakJobBytes > 128 * mib && result.peakJobBytes < 176 * mib);
    await gone(result.pid); await gone(Number(await readFile(pidPath, 'utf8')));
  } finally { await rm(work, { recursive: true, force: true }); }
});

test('native parser job rejects an unbounded descendant process tree', windows, async () => {
  const work = await mkdtemp(join(tmpdir(), 'archive-host-process-count-'));
  try {
    const path = join(work, 'pids.json');
    const script = `const fs=require('fs'),pids=[process.pid];for(let i=0;i<10;i++){const child=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});child.on('error',()=>{});if(child.pid)pids.push(child.pid);fs.writeFileSync(process.argv[1],JSON.stringify(pids));}setInterval(()=>{},1000);`;
    const result = await launch(['-e', script, path]).report;
    assert.equal(result.status, 'resource-limit'); assert.equal(result.assigned, true);
    const pids = JSON.parse(await readFile(path, 'utf8')) as number[];
    assert.ok(pids.length <= 8); for (const pid of pids) await gone(pid);
  } finally { await rm(work, { recursive: true, force: true }); }
});

test('native parser host confines child failures and deadlines', windows, async () => {
  const failure = await launch(['-e', 'process.exit(17)']).report;
  assert.equal(failure.status, 'completed'); assert.equal(failure.code, 17); assert.equal(failure.assigned, true); await gone(failure.pid);
  const timeout = await launch(['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 150 }).report;
  assert.equal(timeout.status, 'timeout'); assert.equal(timeout.assigned, true); await gone(timeout.pid);
});

test('parent EOF and abrupt supervisor death kill both parser and descendants', windows, async () => {
  const work = await mkdtemp(join(tmpdir(), 'archive-host-lifecycle-'));
  try {
    for (const action of ['stdin-eof', 'helper-kill']) {
      const path = join(work, `${action}.json`);
      const script = `const child=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});require('fs').writeFileSync(process.argv[1],JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);`;
      const run = launch(['-e', script, path]);
      // The intentionally killed helper has no final report; attach rejection before killing it.
      const reported = run.report.catch(() => undefined);
      const pids = JSON.parse(await marker(path)) as number[];
      if (action === 'stdin-eof') { run.child.stdin.end(); assert.equal((await reported)!.status, 'parent-exit'); }
      else { run.child.kill(); await reported; }
      for (const pid of pids) await gone(pid);
    }
  } finally { await rm(work, { recursive: true, force: true }); }
});

test('invalid or oversized supervisor configuration launches no process', windows, async () => {
  for (const raw of ['not-json\n', '{}\n', 'x'.repeat(65537) + '\n', JSON.stringify({ executable: process.execPath, args: [], processBytes: 64 * mib, jobBytes: 32 * mib, timeoutMs: 1000 }) + '\n', JSON.stringify({ executable: 'node.exe', args: [], processBytes: 64 * mib, jobBytes: 96 * mib, timeoutMs: 1000 }) + '\n']) {
    const result = await launch([], { raw }).report;
    assert.equal(result.status, 'setup-error'); assert.equal(result.pid, 0); assert.equal(result.assigned, false);
  }
});

test('abrupt supervisor death around process creation leaves no suspended parser orphan', windows, async t => {
  const token = `archive-host-startup-${randomUUID()}`;
  const find = async () => await windowsTask(`$found=@(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {$_.CommandLine -and $_.CommandLine.Contains([string]$inputData.token)} | ForEach-Object {[int]$_.ProcessId}); ConvertTo-Json -InputObject $found -Compress`, { token }) as number[];
  try {
    // No child-code handshake: these kills span native setup, suspended creation and ordinary startup.
    for (const delay of [0, 10, 25, 50, 75, 100, 125, 150, 200, 250]) {
      const run = launch(['-e', 'setInterval(()=>{},1000)', token], { processMiB: 64, jobMiB: 96 });
      const reported = run.report.catch(() => undefined);
      await new Promise(resolve => setTimeout(resolve, delay)); run.child.kill(); await reported;
    }
    const orphans = await find(); assert.deepEqual(orphans, []); t.diagnostic('10 supervisor kills from 0–250 ms after spawn; no matching suspended or running parser processes remained.');
  } finally {
    // If a regression fails, terminate only exact random-token synthetic children from this test.
    for (const pid of await find()) { try { process.kill(pid); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } }
  }
});
