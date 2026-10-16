import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { open, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { CollectionItem, SourceCourse } from '../core/collection-model.js';
import { CollectionError, collectableExtension, collectionDirectory, collectionFileLimit, collectionItemLimit, collectionURL } from '../core/collection.js';

export interface GoogleClient { client_id: string; client_secret?: string }
export interface GoogleConnection { refresh: string; subject: string; label: string; scopes: string[]; attachments: boolean; announcements: boolean; submissions: boolean }
export interface UvecConnection { token: string; subject: string; label: string }
export interface CollectionCredentials { client?: GoogleClient; google?: GoogleConnection; uvec?: UvecConnection }
const prefix = 'https://www.googleapis.com/auth/';
const classroom = 'https://classroom.googleapis.com/v1/';
const uvec = 'https://uvec.upcebu.edu.ph';
const uvecFunctions = ['core_webservice_get_site_info', 'core_enrol_get_users_courses', 'core_course_get_contents'];
export function googleScopes(options: { attachments: boolean; announcements: boolean; submissions: boolean }): string[] {
  return ['openid','email', ...['classroom.courses.readonly','classroom.courseworkmaterials.readonly','classroom.coursework.me.readonly','classroom.topics.readonly', ...(options.announcements ? ['classroom.announcements.readonly'] : []), ...(options.attachments ? ['drive.readonly'] : [])].map(scope => prefix + scope)];
}
export function googleClient(value: unknown): GoogleClient {
  const input = value as { installed?: GoogleClient };
  if (!input?.installed || !/^[\w-]+\.apps\.googleusercontent\.com$/.test(input.installed.client_id) || (input.installed.client_secret !== undefined && (typeof input.installed.client_secret !== 'string' || input.installed.client_secret.length > 300))) throw new Error('Choose a Google OAuth Desktop app client JSON file. Web/service-account credentials are not supported.');
  return { client_id: input.installed.client_id, client_secret: input.installed.client_secret };
}
async function boundedJSON(response: Response, limit = 8 * 1024 ** 2): Promise<any> {
  if (!response.body) throw new Error('The provider returned no response.');
  const chunks: Uint8Array[] = []; let size = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) { size += chunk.length; if (size > limit) { await response.body.cancel().catch(() => {}); throw new Error('Provider response exceeded the safety limit.'); } chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('The provider returned an unexpected response. It may require sign-in or API configuration.'); }
}
async function request(url: string, init: RequestInit, signal: AbortSignal, retry = false, timeout = 30_000): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    let response: Response;
    try { response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]) }); }
    catch { signal.throwIfAborted(); throw new CollectionError('The provider could not be reached securely. Check your connection; redirects are not followed.','temporary'); }
    if (response.ok) return response;
    const status = response.status; const retryAfter = Number(response.headers.get('retry-after'));
    await response.body?.cancel().catch(() => {});
    if (retry && [429,500,502,503,504].includes(status) && attempt < 3) {
      if (Number.isFinite(retryAfter) && retryAfter > 60) throw new CollectionError('The provider requested a longer wait. Pause and retry collection later.','temporary');
      await delay(Math.max(2 ** attempt * 1000 + Math.random() * 300, Number.isFinite(retryAfter) ? retryAfter * 1000 : 0), undefined, { signal }); continue;
    }
    throw new CollectionError(status === 401 ? 'Source sign-in expired. Reconnect this source.' : status === 403 ? 'Access or download permission was denied by the provider.' : status === 404 ? 'The source material is no longer available.' : `Provider request failed (${status}). Try again later.`,[429,500,502,503,504].includes(status)?'temporary':[400,401,403].includes(status)?'attention':'permanent');
  }
}
export async function authorizeGoogle(client: GoogleClient, options: { attachments: boolean; announcements: boolean; submissions: boolean }, openBrowser: (url: string) => Promise<void>, signal: AbortSignal): Promise<{ connection: GoogleConnection; access: string; expires: number }> {
  signal.throwIfAborted();
  const state = randomBytes(32).toString('base64url'); const verifier = randomBytes(48).toString('base64url');
  let settle!: (code: string) => void; let fail!: (error: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => { settle = resolve; fail = reject; });
  // Install the rejection handler before browser opening/listening can fail.
  void codePromise.catch(() => {});
  let redirect = ''; let used = false;
  const server = createServer((req, res) => {
    let url: URL; let expected: URL;
    try { expected = new URL(redirect); url = new URL(req.url ?? '/', expected); }
    catch { res.writeHead(400); res.end('Invalid authorization response.'); return; }
    if (req.method !== 'GET' || url.origin !== expected.origin || url.pathname !== '/oauth2callback' || req.headers.host !== expected.host || url.searchParams.get('state') !== state || used) { res.writeHead(400); res.end('Invalid authorization response.'); return; }
    used = true; const code = url.searchParams.get('code');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    res.end(code ? 'Authorization received. Return to Archive Search.' : 'Authorization declined. Return to Archive Search.');
    if (!code || code.length > 4096) fail(new Error('Google authorization was declined.')); else settle(code);
  });
  const abort = () => fail(new Error('Google sign-in was cancelled or timed out.'));
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 120_000);
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Could not start the local sign-in callback.');
    redirect = `http://127.0.0.1:${address.port}/oauth2callback`;
    const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    auth.search = new URLSearchParams({ client_id: client.client_id, redirect_uri: redirect, response_type: 'code', scope: googleScopes(options).join(' '), access_type: 'offline', prompt: 'consent select_account', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
    await openBrowser(auth.href); const code = await codePromise; signal.throwIfAborted();
    const token = await boundedJSON(await request('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: client.client_id, ...(client.client_secret ? { client_secret: client.client_secret } : {}), redirect_uri: redirect, grant_type: 'authorization_code', code_verifier: verifier }) }, signal), 256_000);
    const granted = typeof token.scope === 'string' ? token.scope.split(' ') : [];
    // Google's consent console canonicalizes this read-only coursework scope.
    const permissions = granted.map((scope: string) => scope === prefix + 'classroom.student-submissions.me.readonly' ? prefix + 'classroom.coursework.me.readonly' : scope);
    const requested = googleScopes(options);
    if (typeof token.access_token !== 'string' || typeof token.refresh_token !== 'string' || token.refresh_token.length > 16_000 || requested.some(scope => !['openid','email'].includes(scope) && !permissions.includes(scope)) || permissions.some((scope: string) => !requested.includes(scope) && !['https://www.googleapis.com/auth/userinfo.email','https://www.googleapis.com/auth/userinfo.profile'].includes(scope))) throw new Error('Google did not grant exactly the intended read permissions. Remove any old grant and reconnect with the selected features.');
    // Identity comes from Google's authenticated HTTPS userinfo endpoint; unverified JWT claims are never used.
    const user = await boundedJSON(await request('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${token.access_token}` } }, signal), 256_000);
    if (!/^\d{1,100}$/.test(user.sub ?? '') || typeof user.email !== 'string' || user.email.length > 200 || user.email_verified !== true) throw new Error('Google account identity could not be verified.');
    return { connection: { refresh: token.refresh_token, subject: user.sub, label: user.email, scopes: granted, attachments: options.attachments, announcements: options.announcements, submissions: options.submissions }, access: token.access_token, expires: Date.now() + Math.min(Number(token.expires_in) || 3600, 3600) * 1000 };
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
function identifier(id: string): string { if (!/^[\w-]{1,200}$/.test(id)) throw new Error('Invalid provider identifier.'); return encodeURIComponent(id); }
function array(value: unknown): any[] { if (!Array.isArray(value) || value.length > 1000) throw new Error('The provider inventory format changed or exceeded its limit.'); return value; }
function string(value: unknown, fallback = '', max = 1000): string { return typeof value === 'string' ? value.slice(0, max) : fallback; }
function plainReference(raw: string): string { try { const url = new URL(raw); return url.protocol === 'https:' && !url.username && !url.password ? url.origin + url.pathname : 'Unsupported or sensitive link omitted.'; } catch { return 'Unavailable link'; } }
function note(course: SourceCourse, key: string, title: string, text: string, sourceURL: string, bucket = '01 Lessons and Study Guides'): CollectionItem {
  return { id: randomUUID(), key, courseId: course.id, course: course.title, title: string(title, 'Untitled'), text: string(text, '', 200_000), sourceURL: collectionURL(sourceURL), kind: 'note', bucket, extension: '.md', revision: createHash('sha256').update(JSON.stringify([title,text,sourceURL])).digest('hex'), size: null, state: 'ready' };
}
export class SchoolProviders {
  private access = ''; private expires = 0; private refreshing?: Promise<void>; private nextRequest = 0;
  constructor(public credentials: CollectionCredentials, private persist: () => Promise<void>, private staging: string) {}
  setAccess(access: string, expires: number): void { this.access = access; this.expires = expires; }
  clearAccess(): void { this.access = ''; this.expires = 0; }
  private async token(signal: AbortSignal): Promise<string> {
    if (this.access && Date.now() < this.expires - 60_000) return this.access;
    if (!this.refreshing) this.refreshing = (async () => {
      const { client, google } = this.credentials; if (!client || !google) throw new Error('Connect Google Classroom first.');
      const response = await request('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: client.client_id, ...(client.client_secret ? { client_secret: client.client_secret } : {}), refresh_token: google.refresh, grant_type: 'refresh_token' }) }, signal).catch(error => {
        if (error instanceof CollectionError && error.kind === 'attention') throw new CollectionError('Google access expired or was denied. Reconnect Google Classroom.','attention');
        throw error;
      });
      const result = await boundedJSON(response, 256_000);
      if (typeof result.access_token !== 'string') throw new CollectionError('Google access expired. Reconnect Google Classroom.','attention');
      this.access = result.access_token; this.expires = Date.now() + Math.min(Number(result.expires_in) || 3600, 3600) * 1000;
      if (typeof result.refresh_token === 'string') { google.refresh = result.refresh_token; await this.persist(); }
    })().finally(() => { this.refreshing = undefined; });
    await this.refreshing; signal.throwIfAborted(); return this.access;
  }
  private async pace(signal: AbortSignal): Promise<void> { const wait = this.nextRequest - Date.now(); this.nextRequest = Math.max(Date.now(), this.nextRequest) + 500; if (wait > 0) await delay(wait, undefined, { signal }); }
  private async google(path: string, query: Record<string,string | string[]>, signal: AbortSignal, drive = false): Promise<any> {
    // Callers are fixed read operations below, never a URL supplied by the renderer or remote document.
    if (drive ? !/^files\/[\w-]+$/.test(path) : !/^courses(?:\/[\w-]+\/(?:topics|courseWorkMaterials|courseWork|announcements|courseWork\/[\w-]+\/studentSubmissions))?$/.test(path)) throw new Error('This Google operation is not allowed.');
    await this.pace(signal); const url = new URL(path, drive ? 'https://www.googleapis.com/drive/v3/' : classroom);
    for (const [key, values] of Object.entries(query)) for (const value of Array.isArray(values) ? values : [values]) url.searchParams.append(key, value);
    return boundedJSON(await request(url.href, { headers: { Authorization: `Bearer ${await this.token(signal)}` } }, signal, true));
  }
  private async pages(path: string, field: string, fields: string, signal: AbortSignal, query: Record<string,string | string[]> = {}): Promise<any[]> {
    const result: any[] = []; let token = ''; let bytes = 0; const seen = new Set<string>();
    do {
      if (seen.has(token)) throw new Error('The provider repeated an inventory page. No complete scan is claimed.'); seen.add(token);
      const page = await this.google(path, { ...query, pageSize: '100', fields, ...(token ? { pageToken: token } : {}) }, signal);
      bytes += Buffer.byteLength(JSON.stringify(page)); if (bytes > 8 * 1024 ** 2) throw new Error('Inventory metadata exceeds 8 MiB. Use a smaller course selection or manual import.');
      result.push(...array(page[field] ?? [])); if (result.length > collectionItemLimit) throw new Error('Inventory exceeds 1,000 items. Select fewer courses or use manual downloads.');
      token = string(page.nextPageToken, '', 8000);
    } while (token);
    return result;
  }
  async courses(source: 'google' | 'uvec', signal: AbortSignal): Promise<SourceCourse[]> {
    if (source === 'google') return (await this.pages('courses', 'courses', 'courses(id,name,courseState),nextPageToken', signal, { studentId: 'me', courseStates: ['ACTIVE','ARCHIVED'] })).map(course => ({ id: String(course.id), title: string(course.name, 'Untitled course', 200), archived: course.courseState === 'ARCHIVED' }));
    const user = this.credentials.uvec; if (!user) throw new Error('Configure a school-approved UVEC read-only token first.');
    return array(await this.moodle('core_enrol_get_users_courses', { userid: user.subject }, signal)).map(course => ({ id: String(course.id), title: string(course.fullname, 'Untitled course', 200), archived: !!course.enddate && Number(course.enddate) * 1000 < Date.now() }));
  }
  async scan(source: 'google' | 'uvec', courses: SourceCourse[], signal: AbortSignal): Promise<{ items: CollectionItem[]; gaps: string[] }> {
    const items: CollectionItem[] = []; const gaps: string[] = []; let bytes = 0;
    const add = (item: CollectionItem) => { if (items.length >= collectionItemLimit) throw new Error('This selection exceeds 1,000 resources. Select fewer courses.'); bytes += Buffer.byteLength(JSON.stringify(item)); if (bytes > 8 * 1024 ** 2) throw new Error('Review metadata exceeds 8 MiB. Select fewer courses.'); items.push(item); };
    for (const course of courses) {
      identifier(course.id); signal.throwIfAborted();
      if (source === 'uvec') {
        gaps.push(`${course.title}: Resource and Folder files only. Activities, submissions and completion-tracked views are not opened.`);
        for (const moduleType of ['resource','folder']) {
          const sections = array(await this.moodle('core_course_get_contents', { courseid: course.id, 'options[0][name]': 'modname', 'options[0][value]': moduleType }, signal));
          for (const section of sections) for (const module of array(section.modules ?? [])) {
            if (module.modname !== moduleType || module.visible === 0 || module.uservisible === false) continue;
            for (const file of array(module.contents ?? [])) {
              if (file.type !== 'file') continue;
              const url = this.uvecFileURL(string(file.fileurl)); const name = string(file.filename, 'Untitled file'); const dot = name.lastIndexOf('.');
              const item = note(course, `uvec:${url}`, name, '', `${uvec}/course/view.php?id=${identifier(course.id)}`);
              const extension = dot >= 0 ? name.slice(dot).toLowerCase() : '.bin';
              if (!collectableExtension(extension)) { gaps.push(`${name}: unsupported file format; import manually if appropriate.`); item.kind = 'reference'; add(item); continue; }
              Object.assign(item, { kind: 'file', extension, title: dot >= 0 ? name.slice(0,dot) : name, downloadURL: url, size: Number(file.filesize) || null, revision: file.timemodified ? `${file.timemodified}:${file.filesize ?? ''}` : randomUUID() }); add(item);
            }
          }
        }
        continue;
      }
      const path = `courses/${identifier(course.id)}`;
      const topics = await this.pages(`${path}/topics`, 'topic', 'topic(topicId,name),nextPageToken', signal);
      add(note(course, `course:${course.id}`, `${course.title} — course context`, topics.map(topic => string(topic.name)).join('\n'), `https://classroom.google.com/c/${course.id}`, '00 Course Info'));
      for (const category of [{ endpoint: 'courseWorkMaterials', field: 'courseWorkMaterial', label: 'Learning material' }, { endpoint: 'courseWork', field: 'courseWork', label: 'Assignment' }, ...(this.credentials.google?.announcements ? [{ endpoint: 'announcements', field: 'announcements', label: 'Announcement' }] : [])]) {
        const fields = `${category.field}(id,${category.endpoint === 'announcements' ? 'text' : 'title,description,topicId'},${category.endpoint === 'courseWork' ? 'dueDate,dueTime,' : ''}updateTime,alternateLink,materials),nextPageToken`;
        const records = await this.pages(`${path}/${category.endpoint}`, category.field, fields, signal);
        for (const record of records) {
          const title = string(record.title, category.label === 'Announcement' ? string(record.text).slice(0,80) : category.label);
          const rawText = record.description || record.text;
          const topic = topics.find(topic => String(topic.topicId) === String(record.topicId));
          const due = record.dueDate;
          const metadata = [topic ? `Topic: ${string(topic.name)}` : '', due && Number.isInteger(due.year) && Number.isInteger(due.month) && Number.isInteger(due.day) ? `Due (UTC): ${due.year}-${String(due.month).padStart(2,'0')}-${String(due.day).padStart(2,'0')}${record.dueTime ? ` ${String(record.dueTime.hours ?? 0).padStart(2,'0')}:${String(record.dueTime.minutes ?? 0).padStart(2,'0')}` : ' (time not supplied)'}` : ''].filter(Boolean).join('\n');
          const textLimit = 200_000 - (metadata ? metadata.length + 2 : 0);
          const partial = typeof rawText === 'string' && rawText.length > textLimit;
          if (partial) gaps.push(`${title}: source text exceeds the capture limit; open the original for the remainder.`);
          const instructions = note(course, `${category.endpoint}:${record.id}`, title, (metadata ? `${metadata}\n\n` : '') + string(rawText, '', partial ? textLimit - 200 : textLimit) + (partial ? '\n[Text capture limited to 200,000 characters. Open the original source for the remainder.]' : ''), string(record.alternateLink));
          if (category.label === 'Assignment') instructions.bucket = '02 Activities and Submissions'; add(instructions);
          await this.materials(array(record.materials ?? []), course, instructions, signal, add, gaps);
          if (this.credentials.google?.submissions && category.endpoint === 'courseWork') {
            const submissions = await this.pages(`${path}/courseWork/${identifier(String(record.id))}/studentSubmissions`, 'studentSubmissions', 'studentSubmissions(id,userId,updateTime,assignmentSubmission(attachments)),nextPageToken', signal, { userId: 'me' });
            for (const submission of submissions) {
              if (String(submission.userId) !== this.credentials.google.subject) throw new Error('Own-submission identity did not match. Nothing from another student was accepted.');
              await this.materials(array(submission.assignmentSubmission?.attachments ?? []), course, { ...instructions, title: `${title} — my work`, bucket: '02 Activities and Submissions' }, signal, add, gaps);
            }
          }
        }
      }
    }
    return { items, gaps };
  }
  private async materials(materials: any[], course: SourceCourse, parent: CollectionItem, signal: AbortSignal, add: (item: CollectionItem) => void, gaps: string[]): Promise<void> {
    for (const material of materials) {
      const drive = material.driveFile?.driveFile ?? material.driveFile;
      const title = string(drive?.title || material.link?.title || material.youtubeVideo?.title || material.form?.title, 'Linked resource');
      const sourceURL = string(drive?.alternateLink || (drive?.id ? `https://drive.google.com/file/d/${drive.id}/view` : '') || material.link?.url || material.youtubeVideo?.alternateLink || material.form?.formUrl);
      const item = note(course, `reference:${parent.key}:${drive?.id || createHash('sha256').update(sourceURL).digest('hex')}`, title, `${parent.title}\n${sourceURL && collectionURL(sourceURL) ? 'Open the original source to access this linked resource.' : 'External link retained as text only: ' + plainReference(sourceURL)}`, sourceURL);
      item.kind = 'reference'; item.bucket = parent.bucket;
      if (drive?.id && this.credentials.google?.attachments) {
        try {
          let fileId = String(drive.id);
          let meta = await this.google(`files/${identifier(fileId)}`, { fields: 'id,name,mimeType,size,version,modifiedTime,capabilities(canDownload),shortcutDetails(targetId,targetMimeType)' }, signal, true);
          if (String(meta.id) !== fileId) throw new Error('Attachment identity did not match the selected course resource.');
          if (meta.mimeType === 'application/vnd.google-apps.shortcut') { fileId = String(meta.shortcutDetails?.targetId); meta = await this.google(`files/${identifier(fileId)}`, { fields: 'id,name,mimeType,size,version,modifiedTime,capabilities(canDownload)' }, signal, true); }
          if (String(meta.id) !== fileId) throw new Error('Attachment identity did not match the selected course resource.');
          const representations: Record<string, [string,string]> = { 'application/vnd.google-apps.document': ['.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document'], 'application/vnd.google-apps.presentation': ['.pptx','application/vnd.openxmlformats-officedocument.presentationml.presentation'], 'application/vnd.google-apps.spreadsheet': ['.pdf','application/pdf'] };
          if (meta.mimeType === 'application/vnd.google-apps.folder') { gaps.push(`${title}: linked folder was not expanded.`); add(item); continue; }
          if (meta.capabilities?.canDownload !== true) { gaps.push(`${title}: provider download restriction.`); add(item); continue; }
          const name = string(meta.name, title); const dot = name.lastIndexOf('.'); const representation = representations[meta.mimeType];
          if (!representation && !collectableExtension(dot >= 0 ? name.slice(dot).toLowerCase() : '')) { gaps.push(`${title}: unsupported file format; saved as a reference.`); add(item); continue; }
          if (!representation && String(meta.mimeType).startsWith('application/vnd.google-apps.')) { gaps.push(`${title}: unsupported Workspace export.`); add(item); continue; }
          Object.assign(item, { kind: 'file', title: representation || dot < 0 ? name : name.slice(0,dot), key: `drive:${meta.id}:${representation?.[1] ?? 'original'}`, fileId: String(meta.id), exportMime: representation?.[1], extension: representation?.[0] ?? name.slice(dot).toLowerCase(), revision: `${meta.version ?? ''}:${meta.modifiedTime ?? ''}`, size: meta.size ? Number(meta.size) : null });
          item.text = undefined;
        } catch (error) { gaps.push(`${title}: ${error instanceof Error ? error.message : 'Attachment unavailable.'}`); }
      }
      add(item);
    }
  }
  private async moodle(name: string, params: Record<string,string>, signal: AbortSignal, token = this.credentials.uvec?.token): Promise<any> {
    if (!uvecFunctions.includes(name) || !token) throw new Error('UVEC operation or token is unavailable.');
    await this.pace(signal);
    const body = new URLSearchParams({ wstoken: token, wsfunction: name, moodlewsrestformat: 'json', ...params });
    const result = await boundedJSON(await request(`${uvec}/webservice/rest/server.php`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }, signal, true));
    if (result?.exception || result?.errorcode) throw new Error('UVEC web services denied this read. Use manual import or request a restricted service from the school.');
    return result;
  }
  async verifyUvec(token: string, signal: AbortSignal): Promise<UvecConnection> {
    if (!/^[a-zA-Z0-9]{16,128}$/.test(token)) throw new Error('Invalid UVEC API token. A school password is never accepted.');
    const info = await this.moodle('core_webservice_get_site_info', {}, signal, token);
    const functions = array(info.functions).map(entry => entry.name);
    if (!/^\d+$/.test(String(info.userid)) || new URL(info.siteurl).origin !== uvec || functions.some(name => !uvecFunctions.includes(name)) || uvecFunctions.some(name => !functions.includes(name))) throw new Error('This UVEC token must be restricted by the school to exactly the three documented read functions. Broad mobile/admin tokens are refused.');
    return { token, subject: String(info.userid), label: string(info.fullname, 'UVEC student', 200) };
  }
  private uvecFileURL(raw: string): string {
    const url = new URL(raw);
    if (url.origin !== uvec || url.username || url.password || !/^\/(?:webservice\/)?pluginfile\.php\/\d+\/(?:mod_resource|mod_folder)\/content\//.test(url.pathname) || /%2f|%5c|%00|\.\./i.test(url.pathname)) throw new Error('UVEC returned an unsupported download location.');
    return uvec + url.pathname.replace(/^\/pluginfile\.php\//, '/webservice/pluginfile.php/');
  }
  async download(source: 'google' | 'uvec', item: CollectionItem, signal: AbortSignal): Promise<string> {
    let url: string; let headers: Record<string,string> = {}; let expected = item.size; let expectedHash = '';
    if (source === 'google') {
      if (!this.credentials.google?.attachments || !item.fileId) throw new Error('Drive attachment access is not enabled.');
      const meta = await this.google(`files/${identifier(item.fileId)}`, { fields: 'id,mimeType,size,version,modifiedTime,sha256Checksum,capabilities(canDownload)' }, signal, true);
      if (String(meta.id) !== item.fileId || (meta.size !== undefined && (!Number.isSafeInteger(Number(meta.size)) || Number(meta.size) < 0))) throw new CollectionError('The provider file identity or size could not be verified. Scan again.','changed');
      if (meta.capabilities?.canDownload !== true) throw new Error('The provider does not permit downloading this file.');
      if (`${meta.version ?? ''}:${meta.modifiedTime ?? ''}` !== item.revision) throw new CollectionError('The source changed after review. Scan again before downloading.','changed');
      expected = item.exportMime ? null : meta.size ? Number(meta.size) : null;
      expectedHash = !item.exportMime && typeof meta.sha256Checksum === 'string' ? meta.sha256Checksum : '';
      const target = new URL(`https://www.googleapis.com/drive/v3/files/${identifier(item.fileId)}${item.exportMime ? '/export' : ''}`);
      target.searchParams.set(item.exportMime ? 'mimeType' : 'alt', item.exportMime ?? 'media'); url = target.href; headers.Authorization = `Bearer ${await this.token(signal)}`;
    } else {
      if (!this.credentials.uvec || !item.downloadURL) throw new Error('UVEC download access is not configured.');
      const target = new URL(this.uvecFileURL(item.downloadURL)); target.searchParams.set('token', this.credentials.uvec.token); url = target.href;
    }
    if (expected !== null && expected > collectionFileLimit) throw new Error('File exceeds 100 MiB. Use a permitted manual download.');
    await this.pace(signal);
    const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
    const response = await request(url, { headers: { ...headers, 'Accept-Encoding': 'identity' } }, boundedSignal, true, 120_000);
    if (/text\/html|application\/json/.test(response.headers.get('content-type') ?? '')) { await response.body?.cancel(); throw new Error('The provider returned a login/error page instead of the document.'); }
    const length = response.headers.get('content-length');
    const announced = length === null ? null : Number(length);
    if ((response.headers.get('content-encoding') ?? 'identity') !== 'identity' || (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(announced) || announced! > collectionFileLimit || (expected !== null && announced !== expected)))) { await response.body?.cancel(); throw new Error('The download transfer size or encoding could not be verified.'); }
    if (item.exportMime && response.headers.get('content-type')?.split(';')[0]?.trim() !== item.exportMime) { await response.body?.cancel(); throw new Error('The exported document content type did not match the reviewed format.'); }
    await mkdir(this.staging, { recursive: true }); await collectionDirectory(this.staging); const path = join(this.staging, `${randomUUID()}.part`); const file = await open(path, 'wx'); let bytes = 0; const digest = createHash('sha256'); let start = Buffer.alloc(0);
    try {
      if (!response.body) throw new Error('No download body was returned.');
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        boundedSignal.throwIfAborted(); bytes += chunk.length; if (bytes > collectionFileLimit) throw new Error('Download exceeded 100 MiB.');
        if (start.length < 512) start = Buffer.concat([start, chunk.subarray(0,512 - start.length)]); digest.update(chunk);
        await file.writeFile(chunk);
      }
      const signature = start.toString('latin1');
      if (/^\s*(?:<!doctype html|<html)/i.test(signature) || (item.extension === '.pdf' && !signature.startsWith('%PDF-')) || (['.docx','.pptx','.xlsx','.zip'].includes(item.extension) && !signature.startsWith('PK'))) throw new Error('The downloaded bytes do not match the expected document format.');
      if (!bytes || (expected !== null && bytes !== expected) || (announced !== null && bytes !== announced)) throw new Error('The download size did not match its receipt.');
      if (expectedHash && digest.digest('hex') !== expectedHash) throw new Error('The provider checksum did not match the downloaded bytes.');
      if (source === 'google') {
        const after = await this.google(`files/${identifier(item.fileId!)}`, { fields: 'version,modifiedTime' }, boundedSignal, true);
        if (`${after.version ?? ''}:${after.modifiedTime ?? ''}` !== item.revision) throw new CollectionError('The source changed during download. Scan again.','changed');
      }
      await file.sync(); boundedSignal.throwIfAborted(); return path;
    } catch (error) { await file.close(); await rm(path, { force: true }); if(!signal.aborted&&(boundedSignal.aborted||error instanceof TypeError))throw new CollectionError('Download was interrupted before completion. Retry when the source is available.','temporary');throw error; }
    finally { await file.close().catch(() => {}); }
  }
  async revokeGoogle(signal: AbortSignal): Promise<void> {
    if (!this.credentials.google) return;
    await request('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: this.credentials.google.refresh }) }, signal);
  }
}
