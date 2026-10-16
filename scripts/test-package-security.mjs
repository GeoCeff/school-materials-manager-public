import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { cp, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { join, normalize, resolve } from 'node:path';
import { getRawHeader, statFile } from '@electron/asar';
import { verifyPackage } from './verify-package.mjs';

assert.ok(process.argv[2] && process.argv[3], 'Pass the packaged directory and a new validation output directory.');
const directory = resolve(process.argv[2]); const output = resolve(process.argv[3]);
assert.ok(output.startsWith(resolve('out') + '\\'), 'Validation output must be beneath out/.');
await mkdir(output); // Never overwrite an existing candidate or evidence directory.
const report = { passed:false, static:await verifyPackage(directory) };
const run = promisify(execFile);
try {
  const destination = join(output,'smoke.json');
  await run(join(directory,'school-materials-manager.exe'),['--smoke','--report',destination], {
    windowsHide:true,timeout:150000,maxBuffer:1024*1024,
    env:{...process.env,ELECTRON_RUN_AS_NODE:'1',NODE_OPTIONS:'--this-invalid-option-must-be-ignored'},
  });
  report.smoke = JSON.parse(await readFile(destination,'utf8'));
  assert.equal(report.smoke.passed,true); assert.equal(report.smoke.queriesPassed,18); assert.equal(report.smoke.sourceHashesUnchanged,true);
  assert.equal(report.smoke.runtime.electron,report.static.electron);
  for (const feature of ['offlineOcr','pdfPageRendering','savedItemsRestart']) assert.equal(report.smoke.releaseFeatures[feature],true);
  for (const name of ['PRIVACY.md','SECURITY.md','COLLECTION_SETUP.md']) assert.deepEqual(await readFile(join(directory,name)),await readFile(name));
  report.policyArtifactsMatch = true;
  report.nodeEnvironmentIgnored = true;
  const tampered = join(output,'tampered-copy'); await cp(directory,tampered,{recursive:true,errorOnExist:true,force:false});
  const helper = join(tampered,'resources','app.asar.unpacked','dist','assets','parser-host.exe');
  const helperBytes = await readFile(helper);
  // A PE overlay leaves the executable runnable; only its sealed digest should reject it.
  await writeFile(helper,Buffer.concat([helperBytes,Buffer.from('synthetic-integrity-probe')]));
  const refusedReport = join(output,'helper-tamper-smoke.json');
  let helperFailure;
  try { await run(join(tampered,'school-materials-manager.exe'),['--smoke','--report',refusedReport],{windowsHide:true,timeout:30000,maxBuffer:256000}); }
  catch(error) { helperFailure=error; }
  assert.ok(helperFailure && !helperFailure.killed && helperFailure.code !== 0,'Changed parser supervisor must fail promptly');
  assert.equal(JSON.parse(await readFile(refusedReport,'utf8')).passed,false);
  report.tamperedParserHostRejected = true;
  await writeFile(helper,helperBytes);
  const archive = join(tampered,'resources','app.asar');
  const info = statFile(archive,normalize('dist/src/desktop/main.js')); const raw = getRawHeader(archive);
  const handle = await open(archive,'r+');
  try {
    const bytes = Buffer.alloc(Number(info.size)); const offset = 8 + raw.headerSize + Number(info.offset);
    await handle.read(bytes,0,bytes.length,offset); const newline = bytes.indexOf(10); assert.ok(newline>0);
    // Replace whitespace with whitespace: code stays valid, but its ASAR content hash changes.
    await handle.write(Buffer.from(' '),0,1,offset+newline);
  } finally { await handle.close(); }
  let failure;
  try { await run(join(tampered,'school-materials-manager.exe'),['--smoke'],{windowsHide:true,timeout:20000,maxBuffer:256000}); }
  catch(error) { failure=error; }
  assert.ok(failure && !failure.killed && failure.code !== 0, 'Tampered ASAR must fail promptly');
  assert.match(`${failure.stdout}\n${failure.stderr}`,/integrity|hash mismatch/i,'Failure must identify ASAR integrity');
  report.tamperedAsarRejected = true; report.passed = true;
} finally {
  await writeFile(join(output,'security-validation.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({passed:report.passed,nodeEnvironmentIgnored:report.nodeEnvironmentIgnored,tamperedParserHostRejected:report.tamperedParserHostRejected,tamperedAsarRejected:report.tamperedAsarRejected,runtimeFiles:report.static.runtimeFiles}));
}
