import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { Server } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { authorizeGoogle, googleClient, googleScopes, SchoolProviders } from '../src/desktop/collection-providers.js';
import { CollectionError, collectionFileLimit } from '../src/core/collection.js';
import type { CollectionItem } from '../src/core/collection-model.js';

const credentials = () => ({ client: { client_id:'fixture.apps.googleusercontent.com' }, google: { refresh:'synthetic-refresh', subject:'123', label:'student@example.invalid', scopes:googleScopes({attachments:true,announcements:false,submissions:false}), attachments:true,announcements:false,submissions:false } });
const course = {id:'course-1',title:'CMSC 123',archived:false};
const signal = () => AbortSignal.timeout(15_000);
const json = (value: unknown) => new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});

test('provider stream limits accept exactly 100 MiB and clean profile storage faults and overflow', { timeout: 60_000 }, async context => {
  const work = await mkdtemp(join(tmpdir(), 'ac-stream-limits-')); const originalFetch = globalThis.fetch; const originalOpen = fs.open;
  const providers = new SchoolProviders(credentials(), async () => {}, work); providers.setAccess('synthetic', Date.now() + 3600_000);
  const item: CollectionItem = { id: 'stream', key: 'stream', courseId: '123', course: 'CMSC 123', title: 'Stream', kind: 'file', bucket: 'Lessons', extension: '.txt', revision: '1:today', fileId: 'stream', sourceURL: '', size: null, state: 'ready' };
  let size = collectionFileLimit; let fault = ''; let received = 0; let cancelled = false;
  const chunk = Buffer.alloc(1024 ** 2, 65);
  const openMock = context.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const file = await originalOpen(...args);
    if (fault) context.mock.method(file, fault === 'EIO' ? 'sync' : 'writeFile', async () => { throw Object.assign(new Error(`Synthetic ${fault}`), { code: fault }); });
    return file;
  }); syncBuiltinESMExports();
  globalThis.fetch = (async input => {
    if (!new URL(String(input)).searchParams.has('alt')) return json({ id: 'stream', version: '1', modifiedTime: 'today', capabilities: { canDownload: true } });
    received = 0; cancelled = false;
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) { if (received === size) controller.close(); else { const next = chunk.subarray(0, Math.min(chunk.length, size - received)); received += next.length; controller.enqueue(next); } },
      cancel() { cancelled = true; },
    }), { headers: { 'Content-Type': 'text/plain' } });
  }) as typeof fetch;
  try {
    const path = await providers.download('google', item, AbortSignal.timeout(30_000));
    assert.equal((await fs.stat(path)).size, collectionFileLimit); assert.equal(received, collectionFileLimit); await rm(path);
    size++; await assert.rejects(providers.download('google', item, AbortSignal.timeout(30_000)), /exceeded 100 MiB/);
    assert.equal(received, collectionFileLimit + 1); assert.deepEqual(await readdir(work), []);
    size = 4 * chunk.length;
    for (fault of ['ENOSPC', 'EACCES', 'EIO']) {
      await assert.rejects(providers.download('google', item, AbortSignal.timeout(30_000)), new RegExp(fault));
      assert.deepEqual(await readdir(work), []); if (fault !== 'EIO') assert.equal(cancelled, true);
    }
    fault = ''; size = 1; const recovered = await providers.download('google', item, AbortSignal.timeout(30_000)); assert.equal((await readFile(recovered)).length, 1); await rm(recovered);
  } finally { globalThis.fetch = originalFetch; openMock.mock.restore(); syncBuiltinESMExports(); await rm(work, { recursive: true, force: true }); }
});

test('provider deadlines stop a real 30-second request and 120-second stalled transfer', { timeout: 175_000 }, async () => {
  const work = await mkdtemp(join(tmpdir(), 'ac-real-deadlines-')); const originalFetch = globalThis.fetch;
  const providers = new SchoolProviders(credentials(), async () => {}, work); providers.setAccess('synthetic', Date.now() + 3600_000);
  let requests = 0; let aborted = false;
  try {
    globalThis.fetch = (async (_input, init) => {
      requests++; return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new TypeError('Synthetic stalled request aborted')), { once: true }));
    }) as typeof fetch;
    let started = performance.now();
    await assert.rejects(providers.courses('google', new AbortController().signal), error => error instanceof CollectionError && error.kind === 'temporary');
    assert.ok(performance.now() - started >= 29_000); assert.equal(requests, 1);
    globalThis.fetch = (async (input, init) => {
      requests++;
      if (!new URL(String(input)).searchParams.has('alt')) return json({ id: 'stream', version: '1', modifiedTime: 'today', capabilities: { canDownload: true } });
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(Buffer.from('bounded partial'));
        init!.signal!.addEventListener('abort', () => { aborted = true; controller.error(new TypeError('Synthetic stalled transfer aborted')); }, { once: true });
      } }), { headers: { 'Content-Type': 'text/plain' } });
    }) as typeof fetch;
    started = performance.now();
    await assert.rejects(providers.download('google', { id: 'stream', key: 'stream', courseId: '123', course: 'CMSC 123', title: 'Stall', kind: 'file', bucket: 'Lessons', extension: '.txt', revision: '1:today', fileId: 'stream', sourceURL: '', size: null, state: 'ready' }, new AbortController().signal), error => error instanceof CollectionError && error.kind === 'temporary');
    assert.ok(performance.now() - started >= 119_000); assert.equal(aborted, true); assert.equal(requests, 3); assert.deepEqual(await readdir(work), []);
  } finally { globalThis.fetch = originalFetch; await rm(work, { recursive: true, force: true }); }
});
const callbackRequest = (callback: URL, path: string, method = 'GET', host = callback.host) => new Promise<number>((resolve, reject) => {
  const request = httpRequest({ hostname: callback.hostname, port: callback.port, path, method, headers: { Host: host } }, response => {
    response.resume(); response.on('end', () => resolve(response.statusCode!));
  });
  request.on('error', reject); request.end();
});

test('rate limits and unavailable networks are retryable while denied reads need attention',async()=>{
  const original=globalThis.fetch;const work=await mkdtemp(join(tmpdir(),'ac-failures-'));const providers=new SchoolProviders(credentials(),async()=>{},work);providers.setAccess('synthetic-access',Date.now()+3600_000);
  try{
    globalThis.fetch=async()=>new Response('slow down',{status:429,headers:{'Retry-After':'120'}});await assert.rejects(providers.courses('google',signal()),error=>error instanceof CollectionError&&error.kind==='temporary');
    globalThis.fetch=async()=>new Response('denied',{status:403});await assert.rejects(providers.courses('google',signal()),error=>error instanceof CollectionError&&error.kind==='attention');
    globalThis.fetch=async()=>{throw new TypeError('synthetic unavailable network');};await assert.rejects(providers.courses('google',signal()),error=>error instanceof CollectionError&&error.kind==='temporary');
  }finally{globalThis.fetch=original;await rm(work,{recursive:true,force:true});}
});

test('Google scopes are read-only and desktop configuration rejects web/service-account clients', () => {
  const scopes = googleScopes({attachments:false,announcements:false,submissions:false}); assert.ok(!scopes.some(scope => /drive\./.test(scope))); assert.ok(!scopes.some(scope => /students|rosters/.test(scope))); assert.ok(scopes.filter(scope => scope.startsWith('https:')).every(scope => scope.endsWith('.readonly')));
  assert.throws(() => googleClient({web:{client_id:'fixture.apps.googleusercontent.com'}}),/Desktop/); assert.throws(() => googleClient({installed:{client_id:'https://evil.example'}}),/Desktop/);
});

test('Google native OAuth survives malformed callbacks and preserves host/path/state/one-use checks and PKCE', async () => {
  const original = globalThis.fetch; let challenge = ''; let exchanges = 0; const options = {attachments:false,announcements:false,submissions:false}; let callback: URL | undefined;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === 'https://oauth2.googleapis.com/token') { exchanges++; const body = init!.body as URLSearchParams; assert.equal(body.get('code'),'synthetic-code'); assert.equal(createHash('sha256').update(body.get('code_verifier')!).digest('base64url'),challenge); return json({access_token:'synthetic-access',refresh_token:'synthetic-refresh',expires_in:3600,scope:googleScopes(options).join(' ')}); }
    assert.equal(url,'https://openidconnect.googleapis.com/v1/userinfo'); return json({sub:'123',email:'student@example.invalid',email_verified:true});
  }) as typeof fetch;
  try {
    const authorized = await authorizeGoogle({client_id:'fixture.apps.googleusercontent.com'},Object.assign(options,{refresh:'forged',subject:'999',label:'forged'}),async raw => {
      const url = new URL(raw); assert.equal(url.origin,'https://accounts.google.com'); assert.equal(url.searchParams.get('code_challenge_method'),'S256'); challenge = url.searchParams.get('code_challenge')!;
      callback = new URL(url.searchParams.get('redirect_uri')!); assert.equal(callback.hostname,'127.0.0.1');
      for (const target of ['http://[', 'http://[invalid/oauth2callback']) assert.equal(await callbackRequest(callback,target),400);
      callback.searchParams.set('code','synthetic-code'); callback.searchParams.set('state','wrong');
      assert.equal((await original(callback)).status,400); callback.searchParams.set('state',url.searchParams.get('state')!);
      const target = callback.pathname + callback.search;
      assert.equal(await callbackRequest(callback,'/wrong' + callback.search),400);
      assert.equal(await callbackRequest(callback,target,'POST'),400);
      assert.equal(await callbackRequest(callback,target,'GET','example.invalid'),400);
      assert.equal(await callbackRequest(callback,'https://example.invalid' + target),400);
      assert.equal((await original(callback)).status,200); assert.equal((await original(callback)).status,400);
    },signal());
    assert.equal(authorized.connection.subject,'123'); assert.equal(authorized.connection.label,'student@example.invalid');
    assert.equal(authorized.connection.refresh,'synthetic-refresh');
    assert.equal(exchanges,1); await assert.rejects(original(callback!));
  } finally { globalThis.fetch = original; }
});

test('Google callback listener closes after cancellation and browser opening failure', async () => {
  const options = {attachments:false,announcements:false,submissions:false};
  for (const failure of ['cancel','browser']) {
    const controller = new AbortController(); let callback: URL | undefined;
    await assert.rejects(authorizeGoogle({client_id:'fixture.apps.googleusercontent.com'},options,async raw => {
      callback = new URL(new URL(raw).searchParams.get('redirect_uri')!);
      if (failure === 'cancel') controller.abort(); else throw new Error('Synthetic browser failure');
    },controller.signal),failure === 'cancel' ? /cancelled|aborted/ : /Synthetic browser failure/);
    await assert.rejects(fetch(callback!));
  }
});

test('Google canonical coursework grants work while missing and broader grants are refused', async () => {
  const original = globalThis.fetch; const options = {attachments:false,announcements:false,submissions:false};
  const canonical = 'https://www.googleapis.com/auth/classroom.student-submissions.me.readonly';
  try {
    for (const mode of ['canonical','missing','broader']) {
      let identityReads = 0;
      globalThis.fetch = (async (input: string | URL | Request) => {
        if (String(input) === 'https://oauth2.googleapis.com/token') {
          let scopes = googleScopes(options).map(scope => scope.replace('classroom.coursework.me.readonly','classroom.student-submissions.me.readonly'));
          if (mode === 'missing') scopes = scopes.filter(scope => scope !== canonical);
          if (mode === 'broader') scopes.push('https://www.googleapis.com/auth/classroom.coursework.me');
          return json({access_token:'synthetic-access',refresh_token:'synthetic-refresh',scope:scopes.join(' ')});
        }
        assert.equal(String(input),'https://openidconnect.googleapis.com/v1/userinfo'); identityReads++;
        return json({sub:'123',email:'student@example.invalid',email_verified:true});
      }) as typeof fetch;
      const attempt = authorizeGoogle({client_id:'fixture.apps.googleusercontent.com'},options,async raw => {
        const url = new URL(raw); const callback = new URL(url.searchParams.get('redirect_uri')!);
        callback.searchParams.set('code','synthetic-code'); callback.searchParams.set('state',url.searchParams.get('state')!);
        assert.equal((await original(callback)).status,200);
      },signal());
      if (mode === 'canonical') { assert.ok((await attempt).connection.scopes.includes(canonical)); assert.equal(identityReads,1); }
      else { await assert.rejects(attempt,/exactly the intended read permissions/); assert.equal(identityReads,0); }
    }
  } finally { globalThis.fetch = original; }
});

test('own-work checks reject another student and unknown Google operations before transport', async () => {
  const original = globalThis.fetch; const account = credentials(); account.google.attachments=false; account.google.submissions=true;
  const providers = new SchoolProviders(account,async()=>{},'unused'); providers.setAccess('synthetic',Date.now()+3600_000); let calls=0;
  globalThis.fetch=(async(input:string | URL | Request)=>{
    calls++;const url=new URL(String(input));
    if(url.pathname.endsWith('/topics'))return json({topic:[]});
    if(url.pathname.endsWith('/courseWorkMaterials'))return json({courseWorkMaterial:[]});
    if(url.pathname.endsWith('/courseWork'))return json({courseWork:[{id:'assignment-1',title:'Problem',description:'Read the original instructions'}]});
    assert.ok(url.pathname.endsWith('/studentSubmissions'));assert.equal(url.searchParams.get('userId'),'me');assert.doesNotMatch(url.searchParams.get('fields')??'',/grade/i);
    return json({studentSubmissions:[{id:'other',userId:'999',assignmentSubmission:{attachments:[]}}]});
  })as typeof fetch;
  try{
    const unsafe=providers as unknown as {google(path:string,query:Record<string,string>,signal:AbortSignal):Promise<unknown>};
    await assert.rejects(unsafe.google('courses/course-1:delete',{},signal()),/not allowed/);assert.equal(calls,0);
    await assert.rejects(providers.scan('google',[course],signal()),/identity did not match/);
  }finally{globalThis.fetch=original;}
});

test('an already cancelled authorization never opens a browser or starts a callback', async () => {
  let opened=false;
  await assert.rejects(authorizeGoogle({client_id:'fixture.apps.googleusercontent.com'},{attachments:false,announcements:false,submissions:false},async()=>{opened=true;},AbortSignal.abort()));
  assert.equal(opened,false);
});

test('Google inventory excludes grades, uses student-only course queries and creates reference-only attachments without Drive consent', async () => {
  const original = globalThis.fetch; const seen:string[] = []; const account = credentials(); account.google.attachments = false;
  const providers = new SchoolProviders(account,async () => {},'unused'); providers.setAccess('synthetic',Date.now()+3600_000);
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)); seen.push(url.href); assert.equal(init?.method,undefined); assert.equal(url.hostname,'classroom.googleapis.com'); assert.doesNotMatch(url.searchParams.get('fields') ?? '',/grade|roster|email/i);
    if (url.pathname === '/v1/courses') { assert.equal(url.searchParams.get('studentId'),'me'); assert.deepEqual(url.searchParams.getAll('courseStates'),['ACTIVE','ARCHIVED']); return json({courses:[{id:course.id,name:course.title,courseState:'ACTIVE'}]}); }
    if (url.pathname.endsWith('/topics')) return json({topic:[{topicId:'1',name:'Graphs'}]});
    if (url.pathname.endsWith('/courseWorkMaterials')) return json({courseWorkMaterial:[{id:'material-1',title:'Lecture',description:'x'.repeat(200_001),alternateLink:'https://classroom.google.com/c/course-1',materials:[{driveFile:{driveFile:{id:'file-1',title:'Lecture.pdf'}}},{link:{url:'https://example.invalid/read?secret=omit',title:'Reference'}}]}]});
    assert.ok(url.pathname.endsWith('/courseWork')); return json({courseWork:[]});
  }) as typeof fetch;
  try {
    assert.equal((await providers.courses('google',signal()))[0]!.id,course.id); const inventory = await providers.scan('google',[course],signal());
    assert.equal(inventory.items.filter(item => item.kind === 'file').length,0); assert.equal(inventory.items.filter(item => item.kind === 'reference').length,2); assert.doesNotMatch(JSON.stringify(inventory),/secret=omit/); assert.equal(seen.length,4); assert.equal(inventory.gaps.length,1); assert.match(inventory.items.find(item=>item.title==='Lecture')!.text!,/Text capture limited/);
  } finally { globalThis.fetch = original; }
});

test('UVEC rejects broad tokens and invokes only the three allowlisted read functions', async () => {
  const original = globalThis.fetch; let broad = true; const calls:string[] = [];
  const providers = new SchoolProviders({},async () => {},'unused');
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input),'https://uvec.upcebu.edu.ph/webservice/rest/server.php'); assert.equal(init?.method,'POST'); const body = init!.body as URLSearchParams; calls.push(body.get('wsfunction')!);
    assert.equal(body.get('wsfunction'),'core_webservice_get_site_info'); return json({siteurl:'https://uvec.upcebu.edu.ph',userid:42,fullname:'Synthetic student',functions:[{name:'core_webservice_get_site_info'},{name:'core_enrol_get_users_courses'},{name:'core_course_get_contents'},...(broad ? [{name:'mod_assign_submit_for_grading'}] : [])]});
  }) as typeof fetch;
  try {
    await assert.rejects(providers.verifyUvec('0123456789abcdef0123456789abcdef',signal()),/restricted/); broad = false; const verified = await providers.verifyUvec('0123456789abcdef0123456789abcdef',signal()); assert.equal(verified.subject,'42');
    const unsafe = providers as unknown as { moodle(name:string,params:Record<string,string>,signal:AbortSignal,token:string): Promise<unknown> };
    await assert.rejects(unsafe.moodle('mod_assign_submit_for_grading',{},signal(),'token'),/operation/); assert.equal(calls.length,2);
  } finally { globalThis.fetch = original; }
});

test('UVEC inventory never opens activity pages and rejects hostile download origins', async () => {
  const original = globalThis.fetch; let hostile = false; const calls:string[] = [];
  const providers = new SchoolProviders({uvec:{token:'synthetic-token',subject:'42',label:'Student'}},async () => {},'unused');
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input),'https://uvec.upcebu.edu.ph/webservice/rest/server.php'); const body = init!.body as URLSearchParams; calls.push(body.get('wsfunction')!);
    assert.equal(body.get('wsfunction'),'core_course_get_contents'); const moduleType = body.get('options[0][value]');
    return json([{modules:moduleType === 'resource' ? [{modname:'resource',visible:0,uservisible:true,contents:[{type:'file',fileurl:'https://evil.example/hidden'}]},{modname:'resource',contents:[{type:'file',filename:'lesson.pdf',filesize:100,timemodified:1,fileurl:`https://${hostile ? '127.0.0.1' : 'uvec.upcebu.edu.ph'}/webservice/pluginfile.php/1/mod_resource/content/1/lesson.pdf?token=never-store`}]}] : []}]);
  }) as typeof fetch;
  try {
    const result = await providers.scan('uvec',[course],signal()); assert.equal(result.items.length,1); assert.doesNotMatch(JSON.stringify(result),/never-store/); assert.equal(result.gaps.length,1);
    hostile = true; await assert.rejects(providers.scan('uvec',[course],signal()),/unsupported download/); assert.ok(calls.every(name => name === 'core_course_get_contents'));
  } finally { globalThis.fetch = original; }
});

test('provider downloads reject login pages, mismatched PDF bytes and source revisions', async () => {
  const work = await mkdtemp(join(tmpdir(),'archive-provider-')); const original = globalThis.fetch; let mode = 'html';
  const providers = new SchoolProviders(credentials(),async () => {},work); providers.setAccess('synthetic',Date.now()+3600_000);
  const item:CollectionItem = {id:'item',key:'drive:file-1:original',courseId:course.id,course:course.title,title:'Lecture',kind:'file',bucket:'01 Lessons and Study Guides',extension:'.pdf',revision:'1:today',sourceURL:'https://drive.google.com/file/d/file-1/view',fileId:'file-1',size:9,state:'ready'};
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input)); assert.equal(url.hostname,'www.googleapis.com');
    if (!url.searchParams.has('alt')) return json({id:'file-1',size:9,version:mode === 'changed' ? '2' : '1',modifiedTime:'today',...(mode==='checksum'?{sha256Checksum:'0'.repeat(64)}:{}),capabilities:{canDownload:true}});
    return mode === 'html' ? new Response('<html>Login</html>',{headers:{'Content-Type':'text/html'}}) : new Response(mode === 'wrong' ? 'not a PDF' : mode === 'truncated' ? '%PDF-' : '%PDF-test',{headers:{'Content-Type':'application/pdf'}});
  }) as typeof fetch;
  try {
    await assert.rejects(providers.download('google',item,signal()),/login\/error/); mode='wrong'; await assert.rejects(providers.download('google',item,signal()),/expected document/); mode='changed'; await assert.rejects(providers.download('google',item,signal()),/changed after review/);
    mode='checksum';await assert.rejects(providers.download('google',item,signal()),/checksum/);mode='truncated';await assert.rejects(providers.download('google',item,signal()),/size did not match/);assert.deepEqual(await readdir(work),[]);
    mode='valid'; const path = await providers.download('google',item,signal()); assert.equal(await readFile(path,'utf8'),'%PDF-test');
  } finally { globalThis.fetch = original; await rm(work,{recursive:true,force:true}); }
});

test('Google inventories retain topics, UTC due dates, announcements and both course pages without grade fields', async () => {
  const original = globalThis.fetch; const account = credentials(); account.google.announcements = true; account.google.attachments = false;
  const providers = new SchoolProviders(account,async()=>{},'unused'); providers.setAccess('synthetic',Date.now()+3600_000);
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)); assert.equal(init?.method,undefined); assert.equal(init?.redirect,'error');
    const fields = url.searchParams.get('fields')!; assert.doesNotMatch(fields,/grades?|rosters?|email|assignee|creator/i);
    if (url.pathname === '/v1/courses') return json(url.searchParams.has('pageToken') ? {courses:[{id:'archived',name:'Old course',courseState:'ARCHIVED'}]} : {courses:[{id:course.id,name:course.title,courseState:'ACTIVE'}],nextPageToken:'next'});
    if (url.pathname.endsWith('/topics')) return json({topic:[{topicId:'topic-1',name:'Trees'}]});
    if (url.pathname.endsWith('/courseWorkMaterials')) { assert.match(fields,/topicId/); return json({courseWorkMaterial:[{id:'material',title:'Notes',description:'Instructions',topicId:'topic-1',alternateLink:'https://classroom.google.com/c/course-1'}]}); }
    if (url.pathname.endsWith('/announcements')) return json({announcements:[{id:'announcement',text:'Read chapter two',alternateLink:'https://classroom.google.com/c/course-1'}]});
    assert.match(fields,/dueDate,dueTime/); return json({courseWork:[{id:'assignment',title:'Problem',description:'Solve it',topicId:'topic-1',dueDate:{year:2026,month:10,day:17},dueTime:{hours:1,minutes:30},alternateLink:'https://classroom.google.com/c/course-1'}]});
  }) as typeof fetch;
  try {
    const courses = await providers.courses('google',signal()); assert.equal(courses.length,2); assert.equal(courses[1]!.archived,true);
    const inventory = await providers.scan('google',[course],signal()); assert.equal(inventory.gaps.length,0);
    const assignment = inventory.items.find(item=>item.key==='courseWork:assignment')!;
    assert.match(assignment.text!,/Topic: Trees/); assert.match(assignment.text!,/Due \(UTC\): 2026-10-17 01:30/); assert.match(assignment.text!,/Solve it/);
    assert.equal(assignment.bucket,'02 Activities and Submissions'); assert.match(assignment.sourceURL,/classroom\.google\.com/);
    assert.match(inventory.items.find(item=>item.key==='announcements:announcement')!.text!,/Read chapter two/);
  } finally { globalThis.fetch = original; }
});

test('repeated and oversized inventory pages fail without claiming a complete scan', async () => {
  const original=globalThis.fetch; const providers=new SchoolProviders(credentials(),async()=>{},'unused'); providers.setAccess('synthetic',Date.now()+3600_000);
  try {
    let calls=0; globalThis.fetch=async()=>{calls++;return json({courses:[],nextPageToken:'same'});};
    await assert.rejects(providers.courses('google',signal()),/repeated an inventory page/); assert.equal(calls,2);
    calls=0;globalThis.fetch=async()=>{calls++;return json({courses:Array.from({length:600},(_,i)=>({id:String(i),name:'Course'})),nextPageToken:String(calls)});};
    await assert.rejects(providers.courses('google',signal()),/1,000/); assert.equal(calls,2);
  } finally {globalThis.fetch=original;}
});

test('denied Google consent and revoked refresh grants stop without echoing provider secrets or retrying', async () => {
  const original=globalThis.fetch;let calls=0;
  try {
    globalThis.fetch=async()=>{calls++;return new Response('synthetic-secret-token',{status:400});};
    const providers=new SchoolProviders(credentials(),async()=>{},'unused');
    await assert.rejects(providers.courses('google',signal()),error=>error instanceof CollectionError&&error.kind==='attention'&&/Reconnect/.test(error.message)&&!/synthetic-secret/.test(error.message));assert.equal(calls,1);
    await assert.rejects(authorizeGoogle({client_id:'fixture.apps.googleusercontent.com'},{attachments:false,announcements:false,submissions:false},async raw=>{
      const url=new URL(raw);const callback=new URL(url.searchParams.get('redirect_uri')!);callback.searchParams.set('state',url.searchParams.get('state')!);callback.searchParams.set('error','access_denied');assert.equal((await original(callback)).status,200);
    },signal()),/declined/);assert.equal(calls,1);
  }finally{globalThis.fetch=original;}
});

test('Drive exports preserve DOCX PPTX and PDF formats and reject inconsistent transfer receipts, checksums and revisions', async () => {
  const original=globalThis.fetch; const work=await mkdtemp(join(tmpdir(),'ac-exports-')); const providers=new SchoolProviders(credentials(),async()=>{},work);providers.setAccess('synthetic',Date.now()+3600_000);
  const representations=[['.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document','PKdocument'],['.pptx','application/vnd.openxmlformats-officedocument.presentationml.presentation','PKslides'],['.pdf','application/pdf','%PDF-sheet']];
  let mode='valid';let metaReads=0;let current=representations[0]!;
  const item=():CollectionItem=>({id:'item',key:'drive:file-1',courseId:course.id,course:course.title,title:'Export',kind:'file',bucket:'Lessons',extension:current[0]!,exportMime:current[1]!,revision:'1:today',fileId:'file-1',sourceURL:'https://drive.google.com/file/d/file-1/view',size:null,state:'ready'});
  globalThis.fetch=(async(input:string|URL|Request,init?:RequestInit)=>{
    const url=new URL(String(input));assert.equal(url.protocol,'https:');assert.equal(url.hostname,'www.googleapis.com');assert.equal(init?.redirect,'error');
    if(!url.pathname.endsWith('/export')){metaReads++;return json({id:mode==='identity'?'other':'file-1',version:mode==='revision'&&metaReads>1?'2':'1',modifiedTime:'today',capabilities:{canDownload:mode!=='restricted'}});}
    assert.equal(url.searchParams.get('mimeType'),current[1]);assert.equal((init!.headers as Record<string,string>)['Accept-Encoding'],'identity');
    if(mode==='denied')return new Response('private error',{status:403});
    const body=current[2]!;return new Response(mode==='empty'?'':body,{headers:{'Content-Type':mode==='type'?'application/octet-stream':current[1]!,'Content-Length':String(mode==='length'?body.length+1:body.length)}});
  })as typeof fetch;
  try{
    for(current of representations){metaReads=0;const path=await providers.download('google',item(),signal());assert.equal(await readFile(path,'utf8'),current[2]);await rm(path);}
    for(mode of ['identity','restricted','revision','type','length','empty','denied']){metaReads=0;await assert.rejects(providers.download('google',item(),signal()));assert.deepEqual(await readdir(work),[]);}
  }finally{globalThis.fetch=original;await rm(work,{recursive:true,force:true});}
});

test('transient transport failures retry at most four times while TLS failures and permanent denial never follow redirects', async () => {
  const original=globalThis.fetch;const providers=new SchoolProviders(credentials(),async()=>{},'unused');providers.setAccess('synthetic',Date.now()+3600_000);
  try{
    for(const status of [401,403,404]){let calls=0;globalThis.fetch=async(_input,init)=>{calls++;assert.equal(init?.redirect,'error');return new Response('credential-like-private-text',{status});};await assert.rejects(providers.courses('google',signal()),error=>error instanceof CollectionError&&!/credential-like/.test(error.message));assert.equal(calls,1);}
    let calls=0;globalThis.fetch=async(_input,init)=>{calls++;assert.equal(init?.redirect,'error');return new Response('busy',{status:503});};await assert.rejects(providers.courses('google',signal()),error=>error instanceof CollectionError&&error.kind==='temporary');assert.equal(calls,4);
    globalThis.fetch=async()=>{throw new TypeError('certificate verify failed: private token');};await assert.rejects(providers.courses('google',signal()),error=>error instanceof CollectionError&&error.kind==='temporary'&&!/private token/.test(error.message));
  }finally{globalThis.fetch=original;}
});

test('OAuth timeout and unavailable loopback ports close cleanly before any token exchange',async()=>{
  const options={attachments:false,announcements:false,submissions:false};let callback:URL|undefined;
  await assert.rejects(authorizeGoogle({client_id:'fixture.apps.googleusercontent.com'},options,async raw=>{callback=new URL(new URL(raw).searchParams.get('redirect_uri')!);},AbortSignal.timeout(25)),/cancelled or timed out/);
  await assert.rejects(fetch(callback!));
  const listen=Server.prototype.listen;let opened=false;
  Server.prototype.listen=function(this:Server){queueMicrotask(()=>this.emit('error',new Error('Synthetic local port unavailable')));return this;} as typeof Server.prototype.listen;
  try{await assert.rejects(authorizeGoogle({client_id:'fixture.apps.googleusercontent.com'},options,async()=>{opened=true;},signal()),/local port unavailable/);assert.equal(opened,false);}
  finally{Server.prototype.listen=listen;}
});

test('Workspace inventory maps only selected course attachments and leaves restricted folders and identity mismatches as references',async()=>{
  const original=globalThis.fetch;const providers=new SchoolProviders(credentials(),async()=>{},'unused');providers.setAccess('synthetic',Date.now()+3600_000);
  const types:Record<string,string>={document:'application/vnd.google-apps.document',presentation:'application/vnd.google-apps.presentation',spreadsheet:'application/vnd.google-apps.spreadsheet',folder:'application/vnd.google-apps.folder',restricted:'application/pdf',mismatch:'application/pdf'};
  globalThis.fetch=(async(input:string|URL|Request)=>{
    const url=new URL(String(input));
    if(url.hostname==='www.googleapis.com'){const id=url.pathname.split('/').at(-1)!;assert.ok(id in types);return json({id:id==='mismatch'?'unreviewed-id':id,name:id,mimeType:types[id],version:'1',modifiedTime:'today',capabilities:{canDownload:id!=='restricted'}});}
    if(url.pathname.endsWith('/topics'))return json({topic:[]});
    if(url.pathname.endsWith('/courseWorkMaterials'))return json({courseWorkMaterial:[{id:'material',title:'Selected course material',materials:Object.keys(types).map(id=>({driveFile:{driveFile:{id,title:id}}}))}]});
    return json({courseWork:[]});
  })as typeof fetch;
  try{const result=await providers.scan('google',[course],signal());const files=result.items.filter(item=>item.kind==='file');assert.deepEqual(files.map(item=>[item.fileId,item.extension,item.exportMime]),[['document','.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document'],['presentation','.pptx','application/vnd.openxmlformats-officedocument.presentationml.presentation'],['spreadsheet','.pdf','application/pdf']]);assert.ok(files.every(item=>item.courseId===course.id&&item.revision==='1:today'));assert.equal(result.items.filter(item=>item.kind==='reference').length,3);assert.equal(result.gaps.length,3);assert.doesNotMatch(JSON.stringify(result),/fileId":"unreviewed-id/);}
  finally{globalThis.fetch=original;}
});
