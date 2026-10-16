# Collect school materials

Open an indexed archive, then select **Collect** in the top bar. Collection creates immutable copies below `Collected`; the existing search service still treats archive files as read-only. Use a local NTFS archive folder on Windows. Network shares, linked/redirected roots, executable attachments, automatic ZIP extraction and video downloading are not supported.

Collection is included in the experimental 0.3.0 [MIT-licensed source](LICENSE). Build locally with `npm start`; this public source snapshot includes no prebuilt Windows binary, OAuth client or school account. Close older app copies before starting a different build. No approved live-course pilot is claimed.

This feature's implementation is tested with original synthetic files, mocked APIs and an isolated Electron application. Google and UVEC live-account checks, administrator permission and applicable OAuth verification remain separate from source publication. No school credentials ship in the source.

## Files from any school

No UVEC token or Google application configuration is required for this workflow. For UVEC, manual browser downloads are the default; the school-service option is under **Advanced**. The app organizes and searches the copies after you select them. It does not download from the portal automatically in this mode.

1. Download only materials you are permitted to keep using the school's normal browser workflow.
2. In Collect, select **Files from any school**, or **UP Cebu · UVEC** for its named manual path.
3. Continue through **Connect** and **Courses**, then select **Choose files for review**. Original files are never moved or edited.
4. In **Organize**, assign the academic year, semester and subject for each course; blanks remain Unclassified. Confirmed mappings are remembered for this archive, source and account. Optional local suggestions only change a draft after you select them; choose **Save organization and review** to confirm.
5. In **Review**, inspect file copies, course text, references and coverage gaps, then select resources. Destination templates, unknown-size estimates, free space and path/file limits are checked before collecting. Zeroes in a filename preview stand for the final content hash; a new managed source folder receives its identifier on first collection. Unsupported or over-size selections are disclosed.
6. Supported content is refreshed into the existing search index after a completed collection when it is idle. **Refresh search index** is also available. Downloaded does not imply searchable: extraction supports fewer formats and has its own size limits.

The app publishes complete, verified bytes without overwriting an existing filename. Later versions use content-dependent names. Reused resources still receive the requested course/semester destination; copies in different courses are independent so edits do not propagate between them. User edits and old copies remain intact. Downloaded/selected file copies receive Windows internet-zone trust metadata; they are never executed automatically. Instructions and references are saved as inert Markdown text.

## Google Classroom

An OAuth client is Google's registration of Archive Search as an application. It identifies the app for Google's sign-in and permission screen. This is a one-time developer/publisher setup; students using a configured build should only sign in and grant the requested access. It is not a UVEC token and is not something each student needs to obtain from their school. The normal sign-in happens on Google's page. Until a real application client is configured, import permitted downloads manually.

The connector uses a Google Cloud OAuth **Desktop app** client. This source checkout includes no publisher client configuration or shared account. Configure your own project using the steps below, or import permitted downloads manually. No publicly verified Google client or real-course pilot is supplied. **External / Testing** projects remain subject to Google's testing restrictions. Without a configured client, the interface explains the missing requirement and offers advanced personal setup or manual import. It does not bypass Workspace administrator restrictions.

1. Create/select your Google Cloud project and enable the **Google Classroom API** and **Google Drive API** if using attachments.
2. Configure the consent screen and intended test audience/users. Create an OAuth client with application type **Desktop app**, then download its client JSON. Do not use a service-account key or a Web app client.
3. In **Connect → Advanced Google setup and permissions**, select **Choose Desktop client JSON**. Client configuration and refresh credentials are stored in an encrypted `connections.bin` in app data, outside the archive and search database. A desktop client is a public client; its packaged client identifier/secret is not a security boundary.
4. Decide whether to enable automatic Drive attachment collection, announcements and your own submission attachments. Reauthorization requires disconnecting first.
5. Choose **Sign in with Google**, complete account selection/consent in the system browser, and return to Archive Search. The app listens only on an ephemeral `127.0.0.1` port for a short-lived PKCE/state-protected callback. Passwords are never entered in Archive Search.
6. Verify the displayed account. List your student courses, select active/archived courses explicitly, and scan them. Scanning reads metadata; it does not bulk-download attachment bytes.
7. Review course text, file copies, links and coverage limitations before collecting.

Classroom permissions: `classroom.courses.readonly`, `classroom.courseworkmaterials.readonly`, `classroom.coursework.me.readonly`, `classroom.topics.readonly`, optional `classroom.announcements.readonly`, plus `openid`/`email` for account identity. The coursework permission can expose grades; requests explicitly select learning fields and do not store grades. Optional own-work requests use `userId=me` and verify the returned owner.

Automatic attachments additionally request **`drive.readonly`**, a broad, restricted Google scope covering all accessible Drive files. Application requests are restricted to attachment IDs discovered in selected courses; this is not a provider-enforced course-specific token. Without that option, the app captures course records and attachment references; use manual file import for copies. `drive.file` is not substituted or described as read-only.

Workspace files export as DOCX (Docs), PPTX (Slides) or PDF (Sheets). Exported representations are not the original interactive documents. Folder expansion, streaming/video capture, unsupported Workspace types and download-restricted files remain reference-only with coverage messages. Drive export limits and permissions still apply. Redirected downloads are refused; the app does not forward tokens to other hosts or alter sharing/copy permissions to bypass restrictions.

References: [Google desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app), [Classroom scopes](https://developers.google.com/workspace/classroom/guides/auth), [Drive scope classifications](https://developers.google.com/workspace/drive/api/guides/api-specific-auth), [Drive downloads/exports](https://developers.google.com/workspace/drive/api/guides/manage-downloads). External OAuth projects in Testing can have short refresh-token lifetimes; production distribution and restricted-scope verification require their own review.

### Optional client configuration for your build

For your own build, create a Desktop client in your Google Cloud project and configure its consent screen, audience and any applicable verification or school-allowance requirements. Keep the downloaded configuration outside the repository, then:

```powershell
npm run build
npm run collection:configure-google -- 'C:/private-config/my-desktop-client.json'
# Validate with a permitted course before relying on automatic collection.
```

The command validates the Desktop client and writes only its `client_id` and optional public-client `client_secret` to ignored `dist/assets/desktop-oauth.json`. Redirect/auth/token URLs and unrelated fields are never copied. The trusted desktop process loads that fixed bundled path; configuration does not add renderer network access. Packaging includes this intentional public-client configuration, while raw downloaded credential files remain excluded. Remove the bundled client with `npm run collection:configure-google -- --clear`.

Configuration is not proof of verification. Before sharing a configured build, record the real client owner, consent audience, enabled APIs, approved scopes and verification status privately, test account selection/revocation, inspect the packaged configuration and repeat the pilot using that exact package. The app never fabricates a working client or an approved Google application.

## UP Cebu UVEC

UVEC is a Moodle-based portal. Whether your account has an approved external service has **not** been established by the implementation. Google sign-in to UVEC does not authorize this app to use a Moodle API. The app does not ask for UVEC passwords, import browser cookies, open activity pages automatically or bypass MFA.

Automatic collection requires the school to provide a student token for an external service restricted to **exactly**:

- `core_webservice_get_site_info`
- `core_enrol_get_users_courses`
- `core_course_get_contents`

File downloads must also be permitted through the school's token-authenticated file service. Broad official-mobile/admin tokens and additional exposed functions are refused. The client checks the service's reported function list, authenticated student identity, exact UVEC origin and resource/folder download paths. This verifies the exposed service contract, not a campus security certification; school approval and a permitted pilot remain required.

Store the school-issued token in a local JSON file, outside the source repository:

```json
{
  "schoolApprovedReadOnly": true,
  "token": "YOUR_SCHOOL_ISSUED_RESTRICTED_TOKEN"
}
```

Select **Choose restricted UVEC token JSON** to connect. The token is OS-encrypted locally. The JSON source is not deleted by the app; protect/remove it yourself when appropriate. The flag records the school's approval requirement; it does not make a broad token read-only.

In **Connect**, choose manual downloads or the school-approved service. **Check setup** reports secure storage, configured access, permitted course API access and the still-required live pilot. Before connection it performs no authenticated school requests. Expand **School administrator request** for a ready-to-review request specifying the three functions, limited student capabilities, file-download permission, expiry/revocation and a one-course pilot. Select/copy and send it yourself through your school's approved contact; this app does not send it.

The connector retrieves only **Resource** and **Folder** file content. It does not call activity-view, completion, grade, enrollment or submission functions. Assignment instructions, forum posts, page activities and personal submissions outside this limited file scope require manual import. Viewing ordinary Moodle activities can change completion, so the app does not crawl them to fill gaps.

If these service permissions are unavailable, use manual UVEC downloads. Other schools work through manual import today; automatic support needs a reviewed adapter, known origin, appropriate service permissions and its own pilot. Entering an arbitrary school URL never grants it access or sends it a token.

References: [UVEC public site](https://uvec.upcebu.edu.ph/), [Moodle external services](https://moodledev.io/docs/5.2/apis/subsystems/external), [view-based completion](https://docs.moodle.org/503/en/Activity_completion_settings).

## Scheduling, interruption and local storage

After completing a reviewed online collection, optionally enable **Collect the approved courses daily while this app is open**. The saved policy retains the selected course IDs, destination, account feature choices and excluded resource keys. It can collect new items in approved courses; it does not add newly discovered courses. No Windows task/startup service is installed, and collection cannot run while the app is closed/asleep. One bounded catch-up is eligible when the app is open and due.

The next daily time advances only after the actual job finishes without failed items. Temporary transfer failures retry the failed items in the same reviewed plan after 5, 15 and 60 minutes, with at most three automatic retries. Temporary inventory failures rescan only the approved courses. Authentication, permission, source-change and persistent failures stop at **Needs attention**. Paused/interrupted jobs require manual action. Status shows the last run, last successful completion and next eligible retry. Fix the issue, finish a reviewed collection, then disable/re-enable the policy to acknowledge attention.

Pause aborts active work and preserves checkpoints. Resume validates account/root and retains completed items. Cancel retains completed copies and does not auto-resume. Incomplete downloads restart from zero; there is no byte-range resume. Durable receipts reconcile a file published just before a crash. Existing files survive remote deletion or expired enrollment. No automatic deletion of imported copies is provided.

**Retry failed resources** retains already completed work and retries failed entries. Source-change failures still need a fresh scan. **Review** can filter file copies, course text, references, failures and formats unsupported by search. The result separates searchable, partial, no-text, unsupported, pending and extraction-failed files. Search coverage reflects the index, not a fresh integrity audit; edited or removed files need Refresh. A collection-catalog save failure pauses without advancing successful counters and retains the publication receipt for reconciliation. Catalog schema 1 migrates transactionally to schema 2; older app builds cannot open schema 2.

Defaults: 1,000 resources/review, 100 selected courses, serial transfers with conservative request pacing, 100 MiB/file, 2 GiB/run, a conservative 10 GiB catalog budget, at least 512 MiB free beyond staging, metadata response/time caps, 120-second downloads and bounded transient retries. Unsupported/blocked/changed-source files are reported rather than claimed successful. Windows path limits and no-clobber publication can require a shorter local NTFS destination.

`data/collection.sqlite` contains private local source metadata, paths, provenance, jobs and version receipts; it is separate from disposable search indexes and is **not encrypted**. Original content and extracted search text also remain unencrypted. DPAPI protects tokens against other Windows users, not malware running as the same user. Moving the app to another Windows profile requires reconnecting.

Disconnect stops collection/schedules and deletes local credentials for that source while retaining copies. Google revocation is attempted; offline/revocation failures explicitly require removing the grant in Google account permissions. UVEC tokens must be revoked through the school/portal. The downloaded token/client JSON files you selected remain where you placed them.

No AI service, cloud content upload, generic portal browser bot or automatic deletion is part of this implementation. Run no real-account pilot until you have the appropriate client/service and authority to access the selected course materials.

## Local organization assistant

The optional assistant uses deterministic local rules, not an AI model. It proposes course codes from titles, groups matching source identities/revisions and shows bounded extractive summaries with attribution. It ranks sentences in the first 50,000 characters of course text by repeated content words, selects up to three, preserves their order and limits output to 600 characters. These summaries can omit important details and must be checked against the full source. Source text is rendered as inert text, including any instructions it contains. Suggestions cannot authorize downloads, change permissions, select courses, execute code or apply labels without confirmation. It does not inspect every file's content for duplicates; byte-different revisions and unrelated local files are not claimed identical.

## Other schools and privacy-preserving qualification

Read [PRIVACY.md](PRIVACY.md) for local storage, scope access and retention, and [SECURITY.md](SECURITY.md) for vulnerability reporting and distribution boundaries. Settings → Forget archive / Clear local data reviews the exact app files and individually selected managed copies, then requires separate Windows confirmation. Disconnect remains separate. Connections/account identity/tokens stay until disconnected; originals, edited/untracked copies, directory names and external backups are preserved. Remove tracked copies before forgetting the catalog if you will need its ownership records. The privacy and security documents accompany the public GitHub source. No shared Google client or verified production consent setup is supplied; an External / Testing project retains its testing restrictions.

The compatibility list distinguishes **manual**, **experimental** and **verified** support. Manual import is available for any school; Google and UVEC remain experimental until authorized live pilots establish compatibility. A successful mocked test or a Moodle logo does not promote a school to verified.

For another campus, begin with its published documentation and an authorized volunteer running the app locally. Review the exact origin, authentication/service capabilities, role limits, file endpoints and possible completion side effects. Use synthetic fixtures for documented responses, then test through the volunteer's own account on their own computer. Do not request their password, cookies, access token or an unredacted API dump. Reuse Moodle normalization when a second permitted integration exists; retain origin-bound credentials and campus-specific tests rather than accepting arbitrary school URLs.

Before adding an automatic school entry, update the reviewed provider operations and allowed link/download origins together, add synthetic inventory/auth/download rejection tests, and document exactly what is captured and omitted. Keep the entry experimental until a permitted pilot verifies inventory, byte integrity, interruption/retry, revocation, account boundaries and unchanged course state. Record evidence without student content or credentials. No automatic-school verification has been completed by this change.

**Privacy and support diagnostics → Preview sanitized report** generates a whitelist-based local report of platform, capability flags, support levels, resource counts, failure categories, index coverage and schedule state. It excludes document text, names, identifiers, tokens, cookies, paths, URLs and raw provider errors. Inspect the preview before **Save previewed report** opens the native save dialog. The exact preview is saved; the app never sends it. Share it only if you choose. This report helps diagnose support; it is not evidence that a campus integration is verified.

## One-course live pilot

1. Confirm permission, client/service setup, intended account, allowed retention and a small approved course selection.
2. Use an isolated local NTFS destination and record the expected materials through an approved school workflow. Avoid sensitive student records.
3. Scan and review the declared coverage; check file/reference counts, selected courses and destination mappings before collecting.
4. Compare captured bytes or provider receipts with the permitted originals. Verify course state, sharing and permissions were not changed. Test duplicate versions without overwriting originals.
5. Test pause/restart/resume, failed-only retry, denied permissions, missing files, disconnect and provider-side revocation. Confirm no new course enters a saved schedule.
6. Refresh and search the permitted copies; distinguish download coverage from extraction coverage. Repeat with the intended distributable and record the remaining gaps privately.

These are future live checks. Synthetic tests do not complete the pilot or grant school approval.

## Developer checks

```powershell
npm test
node scripts/verify-ui.mjs 'C:/path/to/installed/playwright/index.mjs'
node scripts/verify-collection-ui.mjs 'C:/path/to/installed/playwright/index.mjs'
```

The collection UI runner uses its own synthetic archive/app-data directory and a mocked native file chooser. Live Google/UVEC connections are disabled in synthetic demo mode. Test credentials, school files and credential JSONs must remain out of Git and packaged artifacts.
