import type { CollectionAssistance, CollectionPlan, SchoolSupport } from './collection-model.js';
import { collectionMapping } from './collection.js';

export const schoolSupport: SchoolSupport[] = [
  {id:'manual',name:'Files from any school',level:'manual',origin:null,coverage:'Permitted files selected by you.',requirement:'Download materials using your school’s normal workflow.'},
  {id:'google',name:'Google Classroom',level:'experimental',origin:'https://classroom.google.com',coverage:'Course text and references; optional Drive attachments, announcements and your own work.',requirement:'A configured Desktop OAuth application, user consent and any required school administrator allowance. A live pilot is pending.'},
  {id:'uvec',name:'UP Cebu · UVEC',level:'experimental',origin:'https://uvec.upcebu.edu.ph',coverage:'Import your permitted browser downloads without a token. Optional automatic access covers visible Resource and Folder files only.',requirement:'No token is needed for manual import. The optional automatic connector needs a school-approved restricted service and a live pilot.'},
];

export const uvecAdminRequest = `Subject: Request for a limited student materials backup service on UVEC

I would like approval to keep offline copies of learning materials I am allowed to access in my enrolled courses using Archive Search, a local Windows desktop application.

Please confirm whether your policies permit this use. If supported, please provide an individual student token for an external service exposing exactly:
core_webservice_get_site_info
core_enrol_get_users_courses
core_course_get_contents

The service must permit token-authenticated file downloads for visible Resource and Folder content within my existing course permissions. Please apply the minimum student capabilities, token expiry and revocation controls your policies require. Do not add enrollment, grade, submission, activity-view or completion functions; the application refuses broader services.

The app does not collect passwords or browser cookies, open activity pages, change completion, submit work, change permissions or upload materials to an AI service. Tokens are protected with Windows secure storage; retained files and the local search index are unencrypted. Disconnect removes local access; the school must provide the token-revocation procedure.

Before broader use, I propose a permitted pilot with one course and a small set of non-sensitive materials. We will compare the captured inventory and confirm that course state and original files remain unchanged.

If this service is unavailable, I will use permitted manual downloads instead. Please let me know the approved contact, restrictions, retention expectations and revocation process.`;

export function extractiveSummary(value:string):string {
  const text=value.replace(/[\x00-\x08\x0b-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g,'').trim().slice(0,50_000);
  const sentences=[...new Intl.Segmenter(undefined,{granularity:'sentence'}).segment(text)].map(part=>part.segment.trim()).filter(Boolean);
  const common=new Set(['that','this','from','with','your','have','will','they','which','when','into','than','then','there','about','would','could']);
  const words=(sentence:string)=>(sentence.toLowerCase().match(/\p{L}{4,}/gu)??[]).filter(word=>!common.has(word));const frequency=new Map<string,number>();
  for(const word of words(text))frequency.set(word,(frequency.get(word)??0)+1);
  return sentences.map((sentence,index)=>{const tokens=words(sentence);return {sentence,index,score:tokens.reduce((sum,word)=>sum+Math.log1p(frequency.get(word)??0),0)/Math.sqrt(tokens.length||1)};})
    .sort((a,b)=>b.score-a.score||a.index-b.index).slice(0,3).sort((a,b)=>a.index-b.index).map(part=>part.sentence.slice(0,200)).join('\n').slice(0,600);
}

export function collectionAssistance(plan: CollectionPlan): CollectionAssistance {
  const suggestions: CollectionAssistance['suggestions']=[];const groups=new Map<string,string[]>();
  for(const item of plan.items){
    const group=`${item.kind}:${item.key}:${item.revision}`;groups.set(group,[...(groups.get(group)??[]),item.id]);
    if(suggestions.some(s=>s.courseId===item.courseId))continue;
    const match=`${item.course} ${item.title}`.match(/\b([A-Za-z]{2,8})[\s_-]*(\d{1,3})([A-Za-z]?)\b/);
    if(match){const subject=`${match[1]!.toUpperCase()} ${match[2]}${match[3]!.toUpperCase()}`;
      if(collectionMapping(plan,item).subject!==subject)suggestions.push({id:item.id,courseId:item.courseId,subject,reason:'Course code found in the source title. Review before applying.'});}
  }
  // ponytail: deterministic local suggestions need no model or content upload; add a separately consented model only when real use needs it.
  return {planId:plan.id,suggestions,duplicates:[...groups.values()].filter(ids=>ids.length>1).map(ids=>({ids,reason:'Same source identity and revision. Keep separate copies when different courses need them.'})),
    excerpts:plan.items.filter(item=>item.kind==='note'&&item.text?.trim()).slice(0,20).map(item=>({id:item.id,title:item.title,text:extractiveSummary(item.text!),source:item.sourceURL}))};
}
