import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { ArchiveService } from '../dist/src/core/index.js';
import { createDemo } from '../dist/src/demo.js';

assert.ok(process.argv[2],'Pass an already installed playwright/index.mjs path. Build first.');
const {_electron} = await import(pathToFileURL(resolve(process.argv[2])).href);
const output = resolve('output/playwright'); await mkdir(output,{recursive:true});
const sandbox = await mkdtemp(join(tmpdir(),'ac-'));
const root = join(sandbox,'school-materials-manager-demo-archive'); await createDemo(root);
const source = join(sandbox,'CMSC123-lecture.txt'); await writeFile(source,'collectionregression original school lecture');
const extra=join(sandbox,'CMSC123-archive.zip');await writeFile(extra,'synthetic inert archive bytes');const extraBefore=await readFile(extra);
const reportFile=join(sandbox,'support.json');
const before = await readFile(source);
const archive = new ArchiveService(join(sandbox,'school-materials-manager-demo','data')); await archive.init(); await archive.prepareRoot(root); await archive.start('import'); await archive.whenIdle(); await archive.close();
const bootstrap = join(sandbox,'main.mjs');
await writeFile(bootstrap,`import {app,dialog} from 'electron';\nimport {createRequire} from 'node:module';\nglobalThis.collectionRequire=createRequire(import.meta.url);\napp.setPath('appData',${JSON.stringify(sandbox)});\ndialog.showOpenDialog=async()=>({canceled:false,filePaths:${JSON.stringify([source,extra])}});\ndialog.showSaveDialog=async()=>({canceled:false,filePath:${JSON.stringify(reportFile)}});\nawait import(${JSON.stringify(pathToFileURL(resolve('dist/src/desktop/main.js')).href)});\n`);
const app = await _electron.launch({executablePath:resolve('node_modules/electron/dist/electron.exe'),args:[bootstrap,'--demo','--ui-test'],colorScheme:null});
const report = {passed:false,isolated:true,errors:[]}; let page;
try {
  assert.equal(await app.evaluate(({app})=>app.getPath('appData')),sandbox);
  page = await app.firstWindow(); page.on('pageerror',error=>report.errors.push(error.message));
  await page.getByRole('button',{name:'Collect',exact:true}).waitFor();
  const code = await readFile('tests/ui/collection-regression.js','utf8'); report.checks = await(new Function(`return (${code})`))()(page);
  report.policy = await app.evaluate(async ({safeStorage},input) => {
    const {mkdir,readFile,writeFile} = globalThis.collectionRequire('node:fs/promises'); const {join} = globalThis.collectionRequire('node:path'); const {fileURLToPath} = globalThis.collectionRequire('node:url');
    const {CollectionError,CollectionService} = globalThis.collectionRequire(fileURLToPath(input.core)); const {DesktopCollection} = globalThis.collectionRequire(fileURLToPath(input.desktop));
    const check=(value,message)=>{if(!value)throw new Error(message);};
    const data=join(input.sandbox,'policy-data'); const policyRoot=join(input.sandbox,'policy-archive'); await mkdir(policyRoot);
    let mode='note';let release;let downloads=0;
    const store=new CollectionService(data,async()=>{downloads++;if(mode==='hold')await new Promise(resolve=>{release=resolve;});if(mode==='temporary')throw new CollectionError('Synthetic temporary failure','temporary');if(mode==='permission')throw new CollectionError('Synthetic denied read','attention');const path=join(data,'downloads',`${crypto.randomUUID()}.part`);await writeFile(path,'hello');return path;});await store.init();
    const call=async(method,...args)=>{
      if(method==='status')return {root:policyRoot,available:true,canRefresh:false,job:null};
      if(method==='collection-status')return store.snapshot();if(method==='collection-details')return store.details();
      if(method==='collection-coverage')return null;
      if(method==='collection-prepare'){const plan=args[0];return store.prepare(plan.root,plan.source,plan.account,plan.label,plan.items,plan,plan.gaps);}
      if(method==='collection-start')return store.start(args[0]);if(method==='collection-stop')return store.stop(args[0]);if(method==='collection-wait')return store.whenIdle();
      if(method==='collection-retry')return store.resume(true,args[0]===true);
      throw new Error(`Unexpected operation: ${method}`);
    };
    const manager=new DesktopCollection(data,()=>undefined,call,()=>{},false);await manager.status();
    manager.credentials.google={subject:'private-policy-subject',label:'Private policy student',refresh:'synthetic-policy-refresh',scopes:[],attachments:false,announcements:false,submissions:false};
    const scans=[];
    manager.providers={courses:async()=>[{id:'approved',title:'Approved course',archived:false},{id:'new-course',title:'New excluded course',archived:false}],scan:async(_source,courses)=>{
      scans.push(courses.map(course=>course.id));return {gaps:[],items:courses.map(course=>({id:crypto.randomUUID(),key:mode==='note'?'policy-note':mode==='permission'?'permission-file':'policy-file',courseId:course.id,course:course.title,title:'Policy lecture',kind:mode==='note'?'note':'file',bucket:'Lessons',extension:mode==='note'?'.md':'.txt',revision:'1',sourceURL:'https://classroom.google.com/c/approved',size:mode==='note'?null:5,text:mode==='note'?'Synthetic schedule fixture':undefined,state:'ready'}))};
    }};
    try{
      await manager.scan({source:'google',courseIds:['approved'],year:'2026-2027',semester:'First Semester'});await manager.start(store.snapshot().plan.items.map(item=>item.id));await store.whenIdle();
      check(store.snapshot().job.state==='completed','Policy fixture collection failed');await manager.schedule(true);
      manager.credentials.schedule.next=new Date(0).toISOString();await manager.tick();await store.whenIdle();
      await manager.finished(store.snapshot().job);check(manager.credentials.schedule.state==='waiting'&&manager.credentials.schedule.lastSuccess,'Schedule did not record completion');
      check(scans.length===2&&scans.every(ids=>ids.length===1&&ids[0]==='approved'),'Schedule expanded beyond approved courses');
      mode='hold';manager.credentials.schedule.next=new Date(0).toISOString();await manager.tick();
      check(manager.credentials.schedule.state==='running'&&manager.credentials.schedule.next===new Date(0).toISOString(),'Next daily run advanced before transfer completion');
      for(let i=0;i<100&&!release;i++)await new Promise(resolve=>setTimeout(resolve,10));check(release,'Synthetic transfer never began');mode='temporary';release();await store.whenIdle();await manager.finished(store.snapshot().job);
      check(manager.credentials.schedule.state==='retrying'&&manager.credentials.schedule.attempts===1,'Temporary failure did not back off');const beforeRetry=scans.length;mode='success';manager.credentials.schedule.next=new Date(0).toISOString();await manager.tick();await store.whenIdle();await manager.finished(store.snapshot().job);
      check(scans.length===beforeRetry&&manager.credentials.schedule.state==='waiting'&&store.snapshot().job.failed===0,'Failed-only retry rescanned courses or failed to settle');
      mode='permission';manager.credentials.schedule.next=new Date(0).toISOString();await manager.tick();await store.whenIdle();await manager.finished(store.snapshot().job);const beforeAttention=scans.length;await manager.tick();
      check(manager.credentials.schedule.state==='attention'&&scans.length===beforeAttention,'Permission failure was retried automatically');
      const bounded={attempts:0};for(let i=0;i<4;i++)manager.scheduleFailure(bounded,true,'Attention');check(bounded.state==='attention'&&bounded.attempts===3,'Background retries were not bounded');
      const support=await manager.supportText();check(!/private-policy-subject|Private policy student|synthetic-policy-refresh|Policy lecture|policy-archive|AppData|classroom\.google/.test(support),'Diagnostics leaked private fields');
      const encrypted=await readFile(join(data,'connections.bin'));check(!encrypted.includes(Buffer.from('synthetic-policy-refresh')),'Plaintext refresh credential persisted');
      check(JSON.parse(safeStorage.decryptString(encrypted)).google.refresh==='synthetic-policy-refresh','OS encryption round trip failed');
      await manager.scan({source:'google',courseIds:['approved'],year:'2026-2027',semester:'First Semester'});const draft=store.snapshot().plan.id;const before=scans.length;
      manager.credentials.schedule.state='waiting';manager.credentials.schedule.next=new Date(0).toISOString();await manager.tick();check(store.snapshot().plan.id===draft&&scans.length===before,'Schedule overwrote an unreviewed draft');
      const persist=manager.persist;manager.persist=async()=>{throw new Error('Synthetic storage failure');};
      try{await manager.schedule(false);throw new Error('Expected save failure');}catch(error){check(error.message==='Synthetic storage failure','Unexpected policy failure');}
      check(manager.credentials.schedule.enabled===true,'Failed schedule save did not restore its confirmed value');manager.persist=persist;
      const bundled=join(input.sandbox,'publisher-client.json');await writeFile(bundled,JSON.stringify({installed:{client_id:'publisher-fixture.apps.googleusercontent.com'}}));
      const publisher=new DesktopCollection(join(input.sandbox,'publisher-data'),()=>undefined,call,()=>{},false,bundled);
      try{const status=await publisher.status();check(status.connections.google.configured&&status.connections.google.bundled,'Publisher client was not loaded automatically');}finally{publisher.close();}
      return {passed:true,approvedCoursesOnly:true,newCoursesExcluded:true,completionBasedScheduling:true,temporaryBackoff:true,failedOnlyRetry:true,permissionAttention:true,boundedRetries:true,sanitizedDiagnostics:true,publisherClient:true,draftPreserved:true,osEncryptedCredentials:true,saveFailureRollback:true,noLiveNetwork:true};
    }finally{manager.close();await store.close();}
  },{sandbox,core:pathToFileURL(resolve('dist/src/core/collection.js')).href,desktop:pathToFileURL(resolve('dist/src/desktop/collection.js')).href});
  assert.deepEqual(await readFile(source),before);
  assert.deepEqual(await readFile(extra),extraBefore);const exported=JSON.parse(await readFile(reportFile,'utf8'));assert.equal(exported.schema,1);assert.equal(exported.review.resourceTypes.local,2);
  await page.getByRole('button',{name:'Collect',exact:true}).click();
  await page.getByRole('heading',{name:'Collect school materials'}).waitFor();
  await page.getByRole('button',{name:'1 Source',exact:true}).click();
  await page.getByLabel('Source',{exact:true}).selectOption('manual');
  await page.getByRole('button',{name:'4 Organize',exact:true}).click();
  await page.getByRole('button',{name:'Save organization and review',exact:true}).click();
  await page.getByText(/0000000000000000/).first().waitFor();
  await page.screenshot({path:join(output,'collection-desktop.png')});
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(560,760));
  await page.screenshot({path:join(output,'collection-narrow.png')});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Narrow layout overflows');
  assert.equal(await page.getByRole('dialog').evaluate(element=>element.scrollWidth<=element.clientWidth),true,'Narrow dialog content overflows');
  await page.getByRole('button',{name:'Close dialog',exact:true}).click();
  assert.deepEqual(report.errors,[]); report.passed = true; console.log(JSON.stringify(report));
} catch(error) {report.error=error.stack;await page?.screenshot({path:join(output,'collection-failure.png')}).catch(()=>{});throw error;}
finally {await app.close();await writeFile(join(output,'collection-qa.json'),JSON.stringify(report,null,2));}
