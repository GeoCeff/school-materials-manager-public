import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

if (!process.versions.electron) {
  const {test} = await import('node:test');
  test('desktop collection isolates accounts, cancels sign-in, preserves corrupt credentials and exports sanitized support', {timeout:60_000,skip:process.platform!=='win32'}, async()=>{
    const executable = createRequire(import.meta.url)('electron') as string;
    const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
    const result = await promisify(execFile)(executable,[fileURLToPath(import.meta.url)],{env,timeout:55_000,windowsHide:true});
    assert.match(result.stdout,/collection desktop checks passed/);
  });
} else {
  void (async()=>{
  const {app,dialog,safeStorage,shell} = await import('electron');
  const {CollectionService} = await import('../src/core/collection.js');
  const {DesktopCollection} = await import('../src/desktop/collection.js');
  const work=await mkdtemp(join(tmpdir(),'ac-desktop-'));app.setPath('userData',work);app.disableHardwareAcceleration();
  const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw new TypeError('Synthetic offline network');};
  let store:InstanceType<typeof CollectionService>|undefined;let manager:InstanceType<typeof DesktopCollection>|undefined;
  try {
    await app.whenReady();assert.equal(safeStorage.isEncryptionAvailable(),true,'Synthetic credential checks require OS secure storage');
    const root=join(work,'archive');const data=join(work,'profile');await mkdir(root);let activeRoot=root;
    store=new CollectionService(data,async()=>{throw new Error('No provider transfer was expected');});await store.init();
    const call=async(method:string,...args:any[]):Promise<any>=>{
      if(method==='status')return{root:activeRoot,available:true,canRefresh:false,job:null};
      if(method==='collection-status')return store!.snapshot();if(method==='collection-details')return store!.details();if(method==='collection-coverage')return null;
      if(method==='collection-local')return store!.prepareLocal(args[0],args[1],args[2]);
      if(method==='collection-prepare'){const plan=args[0];return store!.prepare(plan.root,plan.source,plan.account,plan.label,plan.items,plan,plan.gaps);}
      if(method==='collection-start')return store!.start(args[0]);if(method==='collection-stop')return store!.stop(args[0]);if(method==='collection-wait')return store!.whenIdle();
      throw new Error(`Unexpected synthetic operation: ${method}`);
    };
    manager=new DesktopCollection(data,()=>undefined,call,()=>{},false);await manager.status();const internals=manager as any;
    assert.equal((await manager.status()).connections.google.configured,false);
    const bundled=join(work,'publisher.json');await writeFile(bundled,JSON.stringify({installed:{client_id:'publisher-fixture.apps.googleusercontent.com'}}));
    const publisher=new DesktopCollection(join(work,'publisher'),()=>undefined,call,()=>{},false,bundled);
    try{const state=await publisher.status();assert.equal(state.connections.google.configured,true);assert.equal(state.connections.google.bundled,true);}finally{publisher.close();}
    const personal=join(work,'personal.json');await writeFile(personal,JSON.stringify({installed:{client_id:'personal-fixture.apps.googleusercontent.com'}}));
    dialog.showOpenDialog=(async()=>({canceled:false,filePaths:[personal]})) as typeof dialog.showOpenDialog;
    await manager.configureGoogle();assert.equal((await manager.status()).connections.google.configured,true);assert.equal((await manager.status()).connections.google.bundled,false);
    let opened!:()=>void;const opening=new Promise<void>(resolve=>{opened=resolve;});shell.openExternal=async()=>{opened();};
    const signing=manager.connectGoogle({attachments:false,announcements:false,submissions:false});await opening;
    await assert.rejects(manager.connectGoogle({attachments:false,announcements:false,submissions:false}),/current source operation/);manager.cancelAuth();await assert.rejects(signing,/cancelled or timed out/);
    const credential={refresh:'synthetic-private-refresh',subject:'123',label:'Synthetic Private Student',scopes:[],attachments:false,announcements:false,submissions:false};
    internals.credentials.google=credential;
    const course={id:'approved',title:'Synthetic Private Course',archived:false};let scans=0;
    internals.providers.courses=async()=>[course];
    internals.providers.scan=async()=>{scans++;return{gaps:[],items:[{id:randomUUID(),key:'source-note',courseId:course.id,course:course.title,title:'Synthetic Private Title',kind:'note',bucket:'Lessons',extension:'.md',revision:'1',sourceURL:'https://classroom.google.com/c/approved',size:null,text:'Synthetic private school content',state:'ready'}]};};
    const selection={source:'google',courseIds:[course.id],year:'2026',semester:'First'};
    await manager.scan(selection);const planId=store.snapshot().plan!.id;
    dialog.showOpenDialog=(async()=>({canceled:true,filePaths:[]})) as typeof dialog.showOpenDialog;
    await manager.chooseFiles({school:'manual',course:'SYN 101',year:'2026',semester:'First'});assert.equal(store.snapshot().plan!.id,planId);
    const local=join(work,'local-review.txt');await writeFile(local,Buffer.alloc(16*1024**2));const fs=createRequire(import.meta.url)('node:fs') as typeof import('node:fs');const {syncBuiltinESMExports}=await import('node:module');
    const readStream=fs.createReadStream;let hashing!:()=>void;const hashStarted=new Promise<void>(resolve=>{hashing=resolve;});
    fs.createReadStream=((...args:Parameters<typeof readStream>)=>{const stream=readStream(...args);hashing();return stream;}) as typeof readStream;syncBuiltinESMExports();
    dialog.showOpenDialog=(async()=>({canceled:false,filePaths:[local]})) as typeof dialog.showOpenDialog;
    try{const review=manager.chooseFiles({school:'manual',course:'SYN 101',year:'2026',semester:'First'});await hashStarted;manager.cancelAuth();await assert.rejects(review,{name:'AbortError'});assert.equal(store.snapshot().plan!.id,planId);}
    finally{fs.createReadStream=readStream;syncBuiltinESMExports();}
    await manager.start(store.snapshot().plan!.items.map(item=>item.id));await store.whenIdle();await manager.schedule(true);
    const policy=internals.credentials.schedule;const RealDate=Date;const originalNow=Date.now();let clockNow=originalNow;
    globalThis.Date=class extends RealDate{constructor(value?:string|number){super(value===undefined?clockNow:value);}static now(){return clockNow;}} as DateConstructor;
    try{clockNow=originalNow-7*86400_000;await internals.tick();assert.equal(scans,1);clockNow=originalNow+7*86400_000;await Promise.all([internals.tick(),internals.tick()]);await store.whenIdle();await manager.finished(store.snapshot().job!);assert.equal(scans,2);assert.equal(internals.credentials.schedule.state,'waiting');assert.ok(Date.parse(internals.credentials.schedule.next)>Date.now());}
    finally{globalThis.Date=RealDate;}
    assert.notEqual(policy.next,new Date(0).toISOString());
    const priorPlan=store.snapshot().plan!.id;const scan=internals.providers.scan;let scanning!:()=>void;let finishScan!:()=>void;
    const scanStarted=new Promise<void>(resolve=>{scanning=resolve;});const scanHeld=new Promise<void>(resolve=>{finishScan=resolve;});
    internals.providers.scan=async(...args:unknown[])=>{scanning();await scanHeld;return scan(...args);};
    const pendingScan=manager.scan(selection);await scanStarted;activeRoot=join(work,'other-archive');finishScan();
    try{
      await assert.rejects(pendingScan,/active archive changed/);assert.equal(store.snapshot().plan!.id,priorPlan);
      const ids=store.snapshot().plan!.items.map(item=>item.id);const job=store.snapshot().job;
      await assert.rejects(manager.start(ids),/current archive/);await assert.rejects(manager.preflight(ids),/current archive/);await assert.rejects(manager.organize([]),/current archive/);
      assert.deepEqual(store.snapshot().job,job);
    }finally{activeRoot=root;internals.providers.scan=scan;}
    await assert.rejects(manager.exportSupport(),/Preview the sanitized report/);
    const report=await manager.supportText();assert.doesNotMatch(report,/Synthetic Private|synthetic-private-refresh|source-note|classroom\.google|private school content/);assert.ok(!report.includes(root));
    const exported=join(work,'support.json');dialog.showSaveDialog=(async()=>({canceled:true,filePath:exported})) as typeof dialog.showSaveDialog;
    await manager.exportSupport();await assert.rejects(readFile(exported),{code:'ENOENT'});await writeFile(exported,'previous synthetic report');
    dialog.showSaveDialog=(async()=>({canceled:false,filePath:exported})) as typeof dialog.showSaveDialog;
    await manager.exportSupport();assert.equal(await readFile(exported,'utf8'),report);
    const copied=store.snapshot().plan!.items[0]!.path!;const copyBefore=await readFile(join(root,copied));
    internals.providers.scan=async()=>({gaps:[],items:[{id:randomUUID(),key:'held-download',courseId:course.id,course:course.title,title:'Held attachment',kind:'file',bucket:'Lessons',extension:'.txt',revision:'1',sourceURL:'https://drive.google.com/file/d/held/view',size:5,fileId:'held',state:'ready'}]});
    let downloading!:()=>void;const transferStarted=new Promise<void>(resolve=>{downloading=resolve;});
    internals.providers.download=async(_source:unknown,_item:unknown,signal:AbortSignal)=>new Promise((_resolve,reject)=>{downloading();signal.addEventListener('abort',()=>reject(new Error('Synthetic transfer cancelled')),{once:true});});
    (store as any).download=(item:unknown)=>manager!.download(77,item as any);await manager.scan(selection);await manager.start(store.snapshot().plan!.items.map(item=>item.id));await transferStarted;
    await manager.disconnect('google');const state=await manager.status();assert.equal(state.connections.google.connected,false);assert.equal(state.schedule.enabled,false);assert.equal(internals.selection,undefined);assert.deepEqual(internals.exclusions,[]);assert.equal(internals.active.size,0);assert.match(state.connections.problem,/grant could not be revoked/);assert.deepEqual(await readFile(join(root,copied)),copyBefore);
    assert.equal(store.snapshot().job!.state,'paused');assert.equal(store.snapshot().job!.published,0);assert.equal(internals.downloadControllers.size,0);
    const encrypted=await readFile(join(data,'connections.bin'));assert.ok(!encrypted.includes(Buffer.from(credential.refresh)));assert.equal(JSON.parse(safeStorage.decryptString(encrypted)).google,undefined);
    internals.credentials.google={...credential,subject:'456'};await assert.rejects(manager.schedule(true),/reviewed online collection/);await assert.rejects(manager.start(store.snapshot().plan!.items.map(item=>item.id)),/another account/);
    internals.selection=selection;await assert.rejects(manager.schedule(true),/reviewed online collection/);
    let providerItem:any;internals.providers.download=async(_source:unknown,item:unknown)=>{providerItem=item;return 'synthetic-receipt';};internals.approvedPlan={...store.details()!,account:'456'};
    const reviewed={...store.details()!.items[0]!,kind:'file' as const,fileId:'reviewed-id'};internals.active=new Map([[reviewed.id,reviewed]]);
    assert.equal(await manager.download(1,{...reviewed,fileId:'forged-id'}),'synthetic-receipt');assert.equal(providerItem.fileId,'reviewed-id');await assert.rejects(manager.download(2,{...reviewed,id:randomUUID()}),/approved collection review/);
    for(const bytes of [Buffer.alloc(0),Buffer.from('truncated synthetic ciphertext'),safeStorage.encryptString('{not JSON'),safeStorage.encryptString(JSON.stringify({google:{refresh:42}}))]){
      const corrupt=await mkdtemp(join(work,'corrupt-'));await writeFile(join(corrupt,'connections.bin'),bytes);const blocked=new DesktopCollection(corrupt,()=>undefined,call,()=>{},false,bundled);
      try{const status=await blocked.status();assert.match(status.connections.problem,/original file was retained/);assert.equal(status.connections.google.configured,false);await assert.rejects(blocked.schedule(false),/Secure credential storage/);assert.deepEqual(await readFile(join(corrupt,'connections.bin')),bytes);}
      finally{blocked.close();}
    }
    console.log('collection desktop checks passed');
  }catch(error){console.error(error);process.exitCode=1;}
  finally{globalThis.fetch=originalFetch;manager?.close();await store?.close();await rm(work,{recursive:true,force:true});app.exit(Number(process.exitCode??0));}
  })();
}
