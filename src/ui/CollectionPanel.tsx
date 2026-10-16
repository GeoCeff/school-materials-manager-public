import { PrivacyDisclosure } from './PrivacyDisclosure.js';
import { useEffect, useRef, useState } from 'react';
import type { CollectionAPI, CollectionAssistance, CollectionCoverage, CollectionPreflight, CollectionStatus, CourseMapping, SourceCourse } from '../core/collection-model.js';

const steps=['Source','Connect','Courses','Organize','Review','Collect'];
const semesters=['','First Semester','Second Semester','Midyear'];
const mib=(bytes:number)=>bytes<1024?`${bytes} B`:bytes<1024**2?`${(bytes/1024).toFixed(1)} KiB`:`${(bytes/1024**2).toFixed(1)} MiB`;
export function CollectionPanel({ api, active, onRefresh }: { api: CollectionAPI; active: boolean; onRefresh: () => void }) {
  const [status,setStatus]=useState<CollectionStatus>();const [error,setError]=useState('');const [pending,setPending]=useState(false);
  const [source,setSource]=useState<'manual'|'google'|'uvec'>('manual');const [uvecMode,setUvecMode]=useState<'manual'|'automatic'>('manual');const [step,setStep]=useState(0);
  const [attachments,setAttachments]=useState(false);const [announcements,setAnnouncements]=useState(false);const [submissions,setSubmissions]=useState(false);
  const [courses,setCourses]=useState<SourceCourse[]>([]);const [selectedCourses,setSelectedCourses]=useState<string[]>([]);const [selectedItems,setSelectedItems]=useState<string[]>([]);
  const [mappings,setMappings]=useState<CourseMapping[]>([]);const [mappingVersion,setMappingVersion]=useState(0);
  const [preflight,setPreflight]=useState<CollectionPreflight>();const [coverage,setCoverage]=useState<CollectionCoverage[]>([]);
  const [assistance,setAssistance]=useState<CollectionAssistance>();const [suggestions,setSuggestions]=useState<string[]>([]);
  const [checks,setChecks]=useState<Awaited<ReturnType<CollectionAPI['setupCheck']>>>();const [report,setReport]=useState('');
  const [filter,setFilter]=useState('all');const [page,setPage]=useState(0);
  const alive=useRef(false);const planId=useRef('');const request=useRef(0);const heading=useRef<HTMLHeadingElement>(null);const adminText=useRef<HTMLTextAreaElement>(null);
  const load=async()=>{
    const id=++request.current;const [next,nextCoverage]=await Promise.all([api.status(),api.coverage()]);if(!alive.current||id!==request.current)return;
    setStatus(next);setCoverage(nextCoverage);
    if(next.plan&&planId.current!==next.plan.id){
      const first=!planId.current;planId.current=next.plan.id;setSelectedItems(next.plan.items.filter(item=>item.state!=='excluded').map(item=>item.id));setPage(0);setFilter('all');setAssistance(undefined);setSuggestions([]);setPreflight(undefined);
      setMappings(next.plan.mappings??[...new Map(next.plan.items.map(item=>[item.courseId,{courseId:item.courseId,year:next.plan!.year,semester:next.plan!.semester,subject:item.course}])).values()]);
      setSource(next.plan.source==='manual'&&next.plan.account==='uvec'?'uvec':next.plan.source);if(next.plan.source==='uvec')setUvecMode('automatic');
      setStep(first&&next.job?5:3);
    }
  };
  useEffect(()=>{
    alive.current=active;if(!active)return;void load().catch(error=>{if(alive.current)setError(error.message);});let timer:ReturnType<typeof setTimeout>|undefined;
    const off=api.progress(()=>{if(!timer)timer=setTimeout(()=>{timer=undefined;void load().catch(error=>{if(alive.current)setError(error.message);});},250);});
    return()=>{alive.current=false;request.current++;off();clearTimeout(timer);};
  },[active,api]);
  useEffect(()=>{if(active)heading.current?.focus();},[step,active]);
  useEffect(()=>{
    let current=true;setPreflight(undefined);if(step!==4||!selectedItems.length||!status?.plan)return;
    void api.preflight(selectedItems).then(value=>{if(current)setPreflight(value);},error=>{if(current)setError(error.message);});return()=>{current=false;};
  },[step,selectedItems,status?.plan?.id,mappingVersion,api]);
  const perform=async(action:()=>Promise<unknown>)=>{setPending(true);setError('');try{await action();if(alive.current)await load();}catch(error){if(alive.current)setError(error instanceof Error?error.message:'Collection failed.');}finally{if(alive.current)setPending(false);}};
  const toggle=(values:string[],id:string)=>values.includes(id)?values.filter(value=>value!==id):[...values,id];
  const job=status?.job;const running=job?.state==='running';const blocked=pending||running||!!status?.connections.authenticating;const local=source==='manual'||source==='uvec'&&uvecMode==='manual';
  const connected=source!=='manual'&&!!status?.connections[source].connected;const items=status?.plan?.items??[];const coverageMap=new Map(coverage.map(item=>[item.id,item.state]));
  const currentReview=!!status?.plan&&status.plan.source===(local?'manual':source)&&(status.plan.source!=='manual'||status.plan.account===(source==='uvec'?'uvec':'manual'));
  const filtered=items.filter(item=>filter==='all'?true:filter==='failed'?item.state==='failed':filter==='unsupported'?coverageMap.get(item.id)==='unsupported':item.kind===filter);
  const visible=filtered.slice(page*50,(page+1)*50);const counts=(kind:string)=>items.filter(item=>kind==='file'?['file','local'].includes(item.kind):item.kind===kind).length;
  const changeMapping=(id:string,key:'year'|'semester'|'subject',value:string)=>setMappings(previous=>previous.map(mapping=>mapping.courseId===id?{...mapping,[key]:value}:mapping));
  const checkConnection=()=>void perform(async()=>{const result=await api.setupCheck(source as 'google'|'uvec');if(alive.current)setChecks(result);});
  const support=status?.schools.find(school=>school.id===source);
  return <section className="collection-panel" aria-label="School materials collection">
    <p className="small-copy">Keep permitted school materials in your archive. Copies and search stay on this computer; connected sources use the internet.</p>
    <nav aria-label="Collection steps"><ol className="collection-steps">{steps.map((name,index)=><li key={name}><button aria-current={step===index?'step':undefined} disabled={pending||index>=3&&!currentReview||running&&index!==5} onClick={()=>{setError('');setStep(index);}}><span>{index+1}</span>{name}</button></li>)}</ol></nav>
    {error&&<p className="notice" role="alert">{error}</p>}
    {status?.connections.problem&&<p className="notice" role="status">{status.connections.problem}</p>}
    {!status&&!error&&<p role="status">Opening collection details…</p>}
    <h3 ref={heading} tabIndex={-1}>{steps[step]}</h3>
    {step===0&&<>
      <div className="collection-label"><label htmlFor="collection-source">Source</label><select id="collection-source" value={source} disabled={blocked} onChange={event=>{setSource(event.target.value as typeof source);setCourses([]);setSelectedCourses([]);setChecks(undefined);setError('');}}><option value="manual">Files from any school</option><option value="google">Google Classroom</option><option value="uvec">UP Cebu · UVEC</option></select></div>
      {support&&<div className="collection-source-detail"><p><strong>{support.name}</strong><span className="collection-badge">{support.level}</span></p><p className="small-copy">{support.coverage}</p><p className="small-copy">{support.requirement}</p></div>}
      <details><summary>School compatibility</summary><ul>{status?.schools.map(school=><li key={school.id}><strong>{school.name} · {school.level}</strong><p>{school.coverage} {school.requirement}</p></li>)}</ul><p>Other schools use manual import. A new automatic connector needs a reviewed origin, permitted service and its own live pilot. Entering a school URL does not grant access.</p></details>
      <button className="primary" disabled={blocked} onClick={()=>setStep(1)}>Continue to connection</button>
    </>}
    {step===1&&<>
      {source==='manual'&&<p>Download materials you are allowed to keep in your normal browser. Select those files in the next step; originals are never moved or edited.</p>}
      {source==='uvec'&&<><p>You do not need a UVEC token to import your downloads. Sign in to UVEC in your normal browser, download materials you are allowed to keep, then continue to select those files.</p><details><summary>Advanced: school-approved UVEC service</summary><div className="collection-label"><label htmlFor="collection-uvec-mode">UVEC collection method</label><select id="collection-uvec-mode" value={uvecMode} disabled={blocked} onChange={event=>{setUvecMode(event.target.value as typeof uvecMode);setChecks(undefined);}}><option value="manual">Import my permitted downloads</option><option value="automatic">Connect a school-approved service</option></select></div><p className="small-copy">This optional integration needs a school-issued token restricted to three read functions. It collects Resource and Folder files. Manual import works without it. Activities, grades, completion and submission controls are not opened.</p></details></>}
      {source==='google'&&<>
        <p>Sign in using your system browser. Choose the access you want before connecting.</p>
        {!status?.connections.google.configured&&<p className="notice">Google sign-in needs a one-time registration of Archive Search with Google. This is developer setup; students should only need to sign in. This build is not configured yet. Use Files from any school for your downloads in the meantime.</p>}
        <details><summary>What is a Google app client?</summary><p>It identifies Archive Search to Google so Google can show the account and permission screen. You sign in on Google's page. The app developer configures it once for the app; each student does not need a Cloud project. It is separate from any UVEC service token.</p></details>
        <label className="check-control"><input type="checkbox" checked={status?.connections.google.connected?status.connections.google.attachments:attachments} disabled={blocked||status?.connections.google.connected} onChange={event=>setAttachments(event.target.checked)}/> Automatically download Drive attachments</label>
        <p className="small-copy">Optional broad read-only Drive access. Google grants access to all accessible Drive files; this app limits retrieval to reviewed course attachments. Leave off for course text and references.</p>
        <label className="check-control"><input type="checkbox" checked={status?.connections.google.connected?status.connections.google.announcements:announcements} disabled={blocked||status?.connections.google.connected} onChange={event=>setAnnouncements(event.target.checked)}/> Include announcements</label>
        <label className="check-control"><input type="checkbox" checked={status?.connections.google.connected?status.connections.google.submissions:submissions} disabled={blocked||status?.connections.google.connected} onChange={event=>setSubmissions(event.target.checked)}/> Include my own assignment attachments</label>
        <p className="small-copy">Before signing in: coursework permission can expose grades, although this app omits grade fields. This Google app is External / Testing; school allowance is separate. Read Privacy, permissions and security below.</p>
        <button className="primary" disabled={blocked||!status?.connections.google.configured||status.connections.google.connected} onClick={()=>void perform(()=>api.connectGoogle({attachments,announcements,submissions}))}>Sign in with Google</button>
        <details><summary>Advanced Google setup and permissions</summary><p>Use a Google Cloud Desktop app client with the Classroom API enabled, plus Drive API for attachments. School administrators may restrict access. Coursework permissions can expose grades; this app requests learning fields and does not save grades or rosters.</p><button disabled={blocked||status?.connections.google.connected} onClick={()=>void perform(()=>api.configureGoogle())}>{status?.connections.google.configured?'Replace Desktop client JSON':'Choose Desktop client JSON'}</button></details>
      </>}
      {source==='uvec'&&uvecMode==='automatic'&&<button disabled={blocked||connected} onClick={()=>void perform(()=>api.connectUvec())}>Choose restricted UVEC token JSON</button>}
      {connected&&<p className="small-copy">Connected: {source==='google'?status?.connections.google.label:status?.connections.uvec.label}</p>}
      {source!=='manual'&&(source==='google'||uvecMode==='automatic'||connected)&&<div className="button-row"><button disabled={blocked} onClick={checkConnection}>Check setup</button>{connected&&<button disabled={pending} onClick={()=>void perform(()=>api.disconnect(source))}>Disconnect {source==='google'?'Google':'UVEC'}</button>}</div>}
      {checks&&<section aria-label="Setup checks"><ul>{checks.checks.map(check=><li key={check.name}><strong>{check.name} · {check.state}</strong><p className="small-copy">{check.detail}</p></li>)}</ul>{checks.request&&<details><summary>School administrator request</summary><p>Review and send this yourself to your school’s approved contact.</p><textarea ref={adminText} readOnly rows={12} aria-label="UVEC administrator request" value={checks.request}/><button onClick={()=>{adminText.current?.focus();adminText.current?.select();}}>Select request text</button></details>}</section>}
      <PrivacyDisclosure /><p className="small-copy">Windows encrypts connection tokens. Retained files, source metadata and search text are unencrypted. Disconnect keeps collected files.</p>
      <button className="primary" disabled={blocked||!local&&!connected} onClick={()=>setStep(2)}>Continue to courses</button>
    </>}
    {step===2&&<>
      {local?<><p>Select files you already downloaded. You’ll assign their academic year, semester and subject next.</p><button className="primary" disabled={blocked} onClick={()=>void perform(()=>api.chooseFiles({year:'',semester:'',course:'',school:source==='uvec'?'uvec':'manual'}))}>Choose files for review</button></>:<>
        <p>Select the courses to scan. New courses are never added to a daily policy automatically.</p><button disabled={blocked||!connected} onClick={()=>void perform(async()=>{const result=await api.courses(source as 'google'|'uvec');if(alive.current){setCourses(result);setSelectedCourses([]);}})}>List my courses</button>
        {courses.length>0&&<fieldset className="collection-courses"><legend>Select courses · active and archived</legend>{courses.map(course=><label className="check-control" key={course.id}><input type="checkbox" disabled={blocked} checked={selectedCourses.includes(course.id)} onChange={()=>setSelectedCourses(toggle(selectedCourses,course.id))}/><span>{course.title}{course.archived&&<small> · archived/past</small>}</span></label>)}</fieldset>}
        <button className="primary" disabled={blocked||!selectedCourses.length} onClick={()=>void perform(()=>api.scan({source:source as 'google'|'uvec',year:'',semester:'',courseIds:selectedCourses}))}>Scan selected courses</button>
      </>}
    </>}
    {step===3&&status?.plan&&<>
      <p>Choose where each course belongs. Confirmed mappings are remembered for this archive and account.</p>
      {mappings.map((mapping,index)=><fieldset className="collection-mapping" key={mapping.courseId}><legend>{items.find(item=>item.courseId===mapping.courseId)?.course??'Course'}</legend><div className="collection-fields">
        <label htmlFor={`collection-subject-${index}`}>Subject / course<input id={`collection-subject-${index}`} value={mapping.subject} maxLength={200} disabled={blocked} onChange={event=>changeMapping(mapping.courseId,'subject',event.target.value)} placeholder="CMSC 123"/></label>
        <label htmlFor={`collection-year-${index}`}>Academic year<input id={`collection-year-${index}`} value={mapping.year} maxLength={70} disabled={blocked} onChange={event=>changeMapping(mapping.courseId,'year',event.target.value)} placeholder="Unclassified, or 2026-2027"/></label>
        <div><label htmlFor={`collection-semester-${index}`}>Semester</label><select id={`collection-semester-${index}`} value={mapping.semester} disabled={blocked} onChange={event=>changeMapping(mapping.courseId,'semester',event.target.value)}>{[...new Set([...semesters,mapping.semester])].map(value=><option key={value} value={value}>{value||'Unclassified'}</option>)}</select></div>
      </div></fieldset>)}
      <details><summary>Local organization assistant</summary><p>Local rules suggest course codes and repeated source identities. Extractive summaries select sentences from course text. Suggestions run entirely on this computer. No model is used and no content is uploaded. Source instructions are displayed as text.</p><button disabled={blocked} onClick={()=>void perform(async()=>{const result=await api.assistance();if(alive.current){setAssistance(result);setSuggestions([]);}})}>Find local suggestions</button>
        {assistance&&<>
          {assistance.suggestions.length===0&&<p>No course-label changes suggested.</p>}
          {assistance.suggestions.map(suggestion=><label className="check-control" key={suggestion.id}><input type="checkbox" checked={suggestions.includes(suggestion.id)} onChange={()=>setSuggestions(toggle(suggestions,suggestion.id))}/><span>Use {suggestion.subject}<small>{suggestion.reason}</small></span></label>)}
          {assistance.suggestions.length>0&&<button disabled={!suggestions.length||blocked} onClick={()=>{setMappings(previous=>previous.map(mapping=>{const suggestion=assistance.suggestions.find(value=>value.courseId===mapping.courseId&&suggestions.includes(value.id));return suggestion?{...mapping,subject:suggestion.subject}:mapping;}));setSuggestions([]);}}>Apply selected labels to draft</button>}
          <p>{assistance.duplicates.length} repeated source identities. Separate course copies are retained.</p>{assistance.duplicates.map((group,index)=><p key={index}>{group.ids.map(id=>items.find(item=>item.id===id)?.title).join(' · ')} — {group.reason}</p>)}
          <details><summary>Source summaries · {assistance.excerpts.length}</summary>{assistance.excerpts.map(excerpt=><article key={excerpt.id}><strong>{excerpt.title}</strong><p className="collection-excerpt">{excerpt.text}</p><p className="small-copy">Source: {excerpt.source||'Course API text'} · extractive summary; omissions are possible. Verify against the full source.</p></article>)}</details>
        </>}
      </details>
      <button className="primary" disabled={blocked||!!job&&['paused','interrupted'].includes(job.state)} onClick={()=>void perform(async()=>{await api.organize(mappings);setMappingVersion(value=>value+1);setStep(4);})}>Save organization and review</button>
      {job&&['paused','interrupted'].includes(job.state)&&<p>Resume or cancel the paused collection before changing its organization.</p>}
    </>}
    {step===4&&status?.plan&&<section aria-label="Collection review">
      <p>{counts('file')} file copies · {counts('note')} course-text records · {counts('reference')} references</p><p className="small-copy">{status.plan.label} · destination: {status.plan.root}\Collected. References save a description/link; their linked bytes are not downloaded.</p>
      {status.plan.gaps.length>0&&<details><summary>{status.plan.gaps.length} coverage limitations</summary><ul>{status.plan.gaps.map((gap,index)=><li key={index}>{gap}</li>)}</ul></details>}
      <div className="button-row"><button disabled={blocked} onClick={()=>setSelectedItems(items.map(item=>item.id))}>Select all resources</button><button disabled={blocked} onClick={()=>setSelectedItems([])}>Clear selection</button></div>
      <div className="collection-label"><label htmlFor="collection-filter">Show resources</label><select id="collection-filter" value={filter} onChange={event=>{setFilter(event.target.value);setPage(0);}}><option value="all">All resources</option><option value="file">Remote file copies</option><option value="local">Selected local files</option><option value="note">Course text</option><option value="reference">References only</option><option value="failed">Failed collection</option><option value="unsupported">Unsupported by search</option></select></div>
      <ul className="collection-items">{visible.map(item=><li key={item.id}><label><input type="checkbox" disabled={blocked} checked={selectedItems.includes(item.id)} onChange={()=>setSelectedItems(toggle(selectedItems,item.id))}/><span><strong>{item.title}</strong><small>{status.plan?.mappings?.find(mapping=>mapping.courseId===item.courseId)?.subject||item.course} · {item.kind==='reference'?'Reference only':item.kind==='note'?'Course text':'File copy'} · {item.state}{item.size!==null&&` · ${mib(item.size)}`}</small>{item.message&&<small className="collection-error">{item.message}</small>}{preflight?.items.find(value=>value.id===item.id)&&<small className="collection-path">{preflight.items.find(value=>value.id===item.id)!.path}</small>}</span></label></li>)}</ul>
      {!filtered.length&&<p>No resources match this view.</p>}
      {filtered.length>50&&<div className="button-row"><button disabled={page===0} onClick={()=>setPage(page-1)}>Previous materials</button><span>Page {page+1} of {Math.ceil(filtered.length/50)}</span><button disabled={(page+1)*50>=filtered.length} onClick={()=>setPage(page+1)}>Next materials</button></div>}
      {selectedItems.length>0&&!preflight&&<p role="status">Checking destinations and local storage…</p>}
      {preflight&&<div className="collection-preflight"><p>{mib(preflight.estimatedBytes)} estimated · {mib(preflight.freeBytes)} free{preflight.unknownSizes>0&&` · ${preflight.unknownSizes} unknown sizes estimated at the per-file limit`}</p><p className="small-copy">Path previews use zeroes for the content hash, assigned after verification. New source folders receive their identifier on first collection. Limits: 100 MiB/file, 2 GiB/run; larger selections pause between bounded runs.</p>{preflight.problems.map(problem=><p className="notice" role="alert" key={problem}>{problem}</p>)}</div>}
      <button className="primary" disabled={blocked||!selectedItems.length||!preflight||!!preflight.problems.length} onClick={()=>void perform(async()=>{await api.start(selectedItems);setStep(5);})}>Collect {selectedItems.length} selected resources</button>
    </section>}
    {step===5&&<>
      {job?<section className="collection-progress" aria-label="Collection progress"><h4>{running?'Collecting materials':job.state.replaceAll('-',' ')}</h4><p role="status">{job.processed} / {job.total} resources · {job.published} published · {job.unchanged} unchanged · {job.failed} failed</p><progress max={job.total||1} value={job.processed} aria-label="Collection resources processed"/>{job.current&&<p className="small-copy">{job.current}</p>}<p className="small-copy">{job.message}</p>
        <div className="button-row">{running?<><button disabled={pending} onClick={()=>void perform(()=>api.stop('pause'))}>Pause collection</button><button disabled={pending} onClick={()=>void perform(()=>api.stop('cancel'))}>Cancel collection</button></>:<>{['paused','interrupted'].includes(job.state)&&<button disabled={pending} onClick={()=>void perform(()=>api.resume())}>Resume collection</button>}{job.failed>0&&<button disabled={pending} onClick={()=>void perform(()=>api.retryFailed())}>Retry failed resources</button>}<button disabled={pending} onClick={onRefresh}>Refresh search index</button><button disabled={pending} onClick={()=>setStep(4)}>Review resource details</button></>}</div>
        <p className="small-copy">Search: {coverage.filter(item=>item.state==='searchable').length} searchable · {coverage.filter(item=>item.state==='partial').length} partial · {coverage.filter(item=>item.state==='no-text').length} without text · {coverage.filter(item=>item.state==='stale').length} stale · {coverage.filter(item=>item.state==='unsupported').length} unsupported · {coverage.filter(item=>['pending','index-unavailable'].includes(item.state)).length} awaiting index · {coverage.filter(item=>item.state==='failed').length} extraction failures.</p>
        <p className="small-copy">Collection failures need retry or a new scan. Search extraction has separate format and size limits. Published files can remain outside searchable coverage.</p>
      </section>:<p>Choose a source and review materials before collecting.</p>}
      <label className="check-control"><input type="checkbox" checked={status?.schedule.enabled??false} disabled={pending||running||!status} onChange={event=>void perform(()=>api.schedule(event.target.checked))}/> Collect the approved courses daily while this app is open</label>
      <p className="small-copy">Schedule: {status?.schedule.state??'off'}. {status?.schedule.message} {status?.schedule.enabled&&status.schedule.state!=='attention'&&status.schedule.next&&`Next eligible run: ${new Date(status.schedule.next).toLocaleString()}.`} {status?.schedule.lastSuccess&&`Last success: ${new Date(status.schedule.lastSuccess).toLocaleString()}.`}</p>
      {status?.schedule.state==='attention'&&<p>Fix the reported issue, complete a reviewed collection, then disable and re-enable the daily policy. It will not retry permission failures automatically.</p>}
      <p className="small-copy">New items in approved courses may be collected automatically; new courses remain excluded. Temporary failures retry up to three times. No task runs while the app is closed or asleep.</p>
      <button disabled={blocked} onClick={()=>{setChecks(undefined);setError('');setStep(0);}}>Start another collection</button>
    </>}
    {(pending||status?.connections.authenticating)&&<div className="button-row"><span role="status">Waiting for source operation…</span><button onClick={()=>void api.cancelAuth()}>Cancel source operation</button></div>}
    <details className="collection-support"><summary>Privacy and support diagnostics</summary><p>Preview an optional report containing capability flags, resource counts and error categories. It excludes names, account IDs, paths, tokens, cookies, URLs and document content. Nothing is sent automatically.</p><button disabled={pending} onClick={()=>void perform(async()=>{const text=await api.supportText();if(alive.current)setReport(text);})}>Preview sanitized report</button>{report&&<><pre aria-label="Sanitized support report">{report}</pre><button disabled={pending} onClick={()=>void perform(()=>api.exportSupport())}>Save previewed report</button></>}</details>
  </section>;
}
