import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ArchiveService } from '../dist/src/core/index.js';
import { CollectionService } from '../dist/src/core/collection.js';

assert.ok(process.argv[2], 'Pass the installed playwright/index.mjs path. Build first.');
const { _electron } = await import(pathToFileURL(resolve(process.argv[2])).href);
const sandbox = await mkdtemp(join(tmpdir(), 'archive-security-ui-'));
const data = join(sandbox,'school-materials-manager-demo','data'); const root = join(sandbox,'archive'); await mkdir(root);
const original = join(sandbox,'synthetic-original.txt'); await writeFile(original,'synthetic private school notes');
await writeFile(join(root,'untracked.txt'),'keep this original');
const archive = new ArchiveService(data); const collector = new CollectionService(data,async()=>{throw new Error('No live network');});
await archive.init(); await collector.init();
await collector.prepareLocal(root,[original],{year:'2026-2027',semester:'First Semester',school:'manual',course:'SYN 101'});
await collector.start(collector.snapshot().plan.items.map(item=>item.id)); await collector.whenIdle();
const copy = collector.details().items[0].path;
await archive.prepareRoot(root); await archive.start('import'); await archive.whenIdle(); await archive.saveSearch('synthetic',{});
await archive.close(); await collector.close();
const bootstrap = join(sandbox,'main.mjs');
await writeFile(bootstrap, `import {app,dialog} from 'electron';
app.setPath('appData',${JSON.stringify(sandbox)});
globalThis.confirmation={answer:0,calls:0,holding:false};
dialog.showMessageBox=async(_window,options)=>{globalThis.confirmation.calls++;globalThis.confirmation.options=options;while(globalThis.confirmation.holding)await new Promise(r=>setTimeout(r,10));return {response:globalThis.confirmation.answer};};
const {DesktopCollection}=await import(${JSON.stringify(pathToFileURL(resolve('dist/src/desktop/collection.js')).href)});
const maintenance=DesktopCollection.prototype.maintenance, forget=DesktopCollection.prototype.forgetCollectionContext, persist=DesktopCollection.prototype.persist;
globalThis.forgetCount=0;
DesktopCollection.prototype.persist=function(){if(globalThis.rejectScheduleWrite){globalThis.rejectScheduleWrite=false;throw new Error('Synthetic schedule storage failure');}return persist.call(this);};
DesktopCollection.prototype.maintenance=async function(action){
  globalThis.fixtureCollection=this;
  if(!globalThis.scheduleSeeded){
    await this.status();
    this.credentials.schedule={enabled:true,next:new Date(Date.now()+86400000).toISOString(),selection:{source:'google',courseIds:['synthetic-approved'],year:'2026-2027',semester:'First Semester'},root:${JSON.stringify(root)},excluded:[],state:'waiting'};
    await this.persist();globalThis.scheduleSeeded=true;
  }
  return maintenance.call(this,action);
};
DesktopCollection.prototype.forgetCollectionContext=async function(){globalThis.forgetCount++;return forget.call(this);};
await import(${JSON.stringify(pathToFileURL(resolve('dist/src/desktop/main.js')).href)});
`);
const application = await _electron.launch({executablePath:resolve('node_modules/electron/dist/electron.exe'),args:[bootstrap,'--demo','--ui-test'],colorScheme:null});
const report = {passed:false,isolated:true,noLiveNetwork:true}; let page;
try {
  assert.equal(await application.evaluate(({app})=>app.getPath('appData')),sandbox);
  page = await application.firstWindow(); await page.getByRole('button',{name:'Settings',exact:true}).click();
  await page.getByText('Privacy, permissions and security',{exact:true}).click();
  assert.ok(await page.getByText(/coursework permission can expose grades even though/i).isVisible());
  assert.equal(await page.evaluate(()=>Notification.requestPermission()),'denied'); report.rendererPermissionDenied=true;
  assert.match(await page.evaluate(async()=>{try{await window.archive.clearExecute('not-reviewed',[]);return 'unexpected';}catch(error){return error.message;}}),/Review/);
  const saved = page.getByRole('checkbox',{name:'All saved searches and bookmarks, across archives'}); await saved.check();
  await page.getByRole('button',{name:'Review removal scope',exact:true}).click(); await page.getByLabel('Removal scope').waitFor();
  assert.equal(await saved.isChecked(),true);
  const connectionsBefore=await readFile(join(data,'connections.bin'));
  assert.match(await page.evaluate(async()=>{try{await window.archive.clearExecute('not-reviewed',[]);return 'unexpected';}catch(error){return error.message;}}),/Review/);
  await application.evaluate(()=>{globalThis.confirmation.answer=1;globalThis.confirmation.holding=true;});
  await page.getByRole('button',{name:'Continue to Windows confirmation'}).click();
  await application.evaluate(async()=>{for(let attempt=0;attempt<200&&!globalThis.confirmation.calls;attempt++)await new Promise(resolve=>setTimeout(resolve,10));if(globalThis.confirmation.calls!==1)throw new Error('Native confirmation did not open.');});
  const changedScope=join(data,`saved-${randomUUID()}.tmp`); await writeFile(changedScope,'synthetic newly staged saved item');
  await application.evaluate(()=>{globalThis.confirmation.holding=false;});
  await page.getByRole('status').filter({hasText:/changed after review/}).waitFor();
  assert.equal(await application.evaluate(()=>globalThis.fixtureCollection.credentials.schedule.enabled),true);
  assert.equal(await application.evaluate(()=>globalThis.forgetCount),0);
  assert.deepEqual(await readFile(join(data,'connections.bin')),connectionsBefore);
  assert.equal((await page.evaluate(()=>window.archive.saved())).length,1);
  await rm(changedScope);
  report.rejectedReviewPreservesSchedule=true;
  await application.evaluate(()=>{globalThis.confirmation.answer=0;});
  await page.getByRole('button',{name:'Review removal scope',exact:true}).click(); await page.getByLabel('Removal scope').waitFor();
  await page.getByRole('button',{name:'Continue to Windows confirmation'}).click();
  await page.getByRole('status').filter({hasText:'Cancelled. No data removed.'}).waitFor();
  assert.equal((await page.evaluate(()=>window.archive.saved())).length,1);
  assert.equal(await application.evaluate(()=>globalThis.fixtureCollection.credentials.schedule.enabled),true);
  assert.deepEqual(await readFile(join(data,'connections.bin')),connectionsBefore); report.nativeCancellationPreservesData=true;
  await saved.uncheck();
  await page.getByRole('checkbox',{name:'Review individual managed copies in the current archive'}).check();
  await page.getByRole('button',{name:'Review removal scope',exact:true}).click(); await page.getByLabel('Removal scope').waitFor();
  const copyCheckbox = page.getByRole('checkbox',{name:copy,exact:true}); assert.equal(await copyCheckbox.isChecked(),false); await copyCheckbox.check();
  const overflow = await page.locator('dialog').evaluate(dialog=>dialog.scrollWidth>dialog.clientWidth+1); assert.equal(overflow,false);
  await mkdir('output/playwright',{recursive:true}); await page.screenshot({path:'output/playwright/security-clear-review.png'});
  report.reviewLayoutFits=true;
  await application.evaluate(()=>{globalThis.confirmation.answer=1;globalThis.rejectScheduleWrite=true;});
  await page.getByRole('button',{name:'Continue to Windows confirmation'}).click();
  await page.getByRole('status').filter({hasText:/Synthetic schedule storage failure/}).waitFor();
  assert.equal(await application.evaluate(()=>globalThis.fixtureCollection.credentials.schedule.enabled),true);
  assert.deepEqual(await readFile(join(data,'connections.bin')),connectionsBefore);
  assert.equal(await readFile(join(root,copy),'utf8'),'synthetic private school notes');
  assert.equal((await page.evaluate(()=>window.archive.saved())).length,1);
  assert.equal((await page.evaluate(()=>window.archive.status())).root,root);
  report.scheduleWriteFailurePreservesData=true;
  await page.getByRole('button',{name:'Review removal scope',exact:true}).click(); await copyCheckbox.waitFor(); await copyCheckbox.check();
  await application.evaluate(()=>{globalThis.confirmation.answer=1;globalThis.confirmation.holding=true;});
  await page.getByRole('button',{name:'Continue to Windows confirmation'}).click();
  const maintenanceDeadline=Date.now()+6000;
  while (!await page.evaluate(()=>window.archive.status().then(()=>false,()=>true))) {
    assert.ok(Date.now()<maintenanceDeadline,'Maintenance did not block concurrent IPC');
    await page.waitForTimeout(30);
  }
  const details = await application.evaluate(()=>globalThis.confirmation.options);
  assert.match(details.detail,/1 individually selected managed copies/); assert.equal(details.defaultId,0); report.maintenanceBlocksConcurrentIPC=true;
  await application.evaluate(()=>{globalThis.confirmation.holding=false;});
  await page.getByRole('status').filter({hasText:'1 files removed.'}).waitFor();
  await assert.rejects(readFile(join(root,copy)),{code:'ENOENT'}); assert.equal(await readFile(original,'utf8'),'synthetic private school notes');
  assert.equal(await readFile(join(root,'untracked.txt'),'utf8'),'keep this original');
  assert.equal((await page.evaluate(()=>window.archive.saved())).length,1); report.individualSelectionAndOriginals=true;
  assert.equal(await application.evaluate(()=>globalThis.fixtureCollection.credentials.schedule),undefined);
  assert.equal(await application.evaluate(()=>globalThis.forgetCount),2); report.confirmedRemovalDisablesSchedule=true;
  // Make settings usable after forgetting the last archive too.
  await page.getByRole('checkbox',{name:'Review individual managed copies in the current archive'}).uncheck();
  await page.getByRole('checkbox',{name:/Forget archives:/}).check();
  await page.getByRole('button',{name:'Review removal scope',exact:true}).click(); await page.getByLabel('Removal scope').waitFor();
  await page.getByRole('button',{name:'Continue to Windows confirmation'}).click();
  const removalDeadline=Date.now()+6000;
  while (!await page.evaluate(()=>window.archive.status().then(status=>status.root===null,()=>false))) {
    assert.ok(Date.now()<removalDeadline,'Archive removal did not finish');
    await page.waitForTimeout(30);
  }
  assert.ok(await page.getByRole('button',{name:'Settings',exact:true}).isVisible()); report.forgetArchive=true;
  report.passed=true;
} catch(error) { report.error=error.stack; throw error; }
finally {
  await application.close(); await mkdir('output/playwright',{recursive:true});
  await writeFile('output/playwright/security-ui.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
}
