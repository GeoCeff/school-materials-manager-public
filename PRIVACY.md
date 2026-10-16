# Archive Search privacy policy

Prepared October 16, 2026. Applies to the Windows desktop application with optional collection, shared as a personal, experimental [MIT-licensed source project](LICENSE). Maintainer and privacy contact: **geogabaisen@gmail.com**. This document accompanies the public GitHub source; no prebuilt binary, shared OAuth client or account is supplied. Publication of this document does not establish a verified Google consent-policy setup.

## Your computer and your choices

Archive Search searches a folder you choose and can optionally collect materials you are permitted to keep. It has no central student-data server, telemetry, advertising, data-sale service or AI content-upload backend. Search, OCR, organization suggestions and extractive summaries run locally. We do not receive your archive or account data through an application backend. Sending us a support email is a separate action you choose; your email provider and ours process that correspondence.

Original archive files are read-only to search. Collection writes separately managed copies beneath `Collected` in the selected archive. Opening a document in another application, using a cloud-synced archive, device backups or exporting a support report can make copies outside Archive Search's control. Those applications, sync providers and your school's rules have their own terms.

## Information accessed and why

- Local search reads selected files and stores extracted text, filenames, paths, academic labels, file fingerprints, OCR provenance and indexing status/history to provide offline search and previews. Bookmarks and saved searches persist separately from disposable indexes.
- Optional Google sign-in uses your system browser. Archive Search receives account identity (including email/account identifier), tokens and the read permissions you consent to. It does not ask for your Google password. Read-only Classroom access supplies courses, topics, learning materials and coursework text/references. Optional announcements and your own assignment attachments are separate app choices. The coursework permission can expose grades: current API field masks omit grades and rosters, but that does not narrow the underlying Google grant to exclude grades. Course text or documents can themselves contain personal information.
- Optional automatic Drive attachments require broad `drive.readonly` access to all Drive files accessible to your account. It is **off by default**. The implementation restricts retrieval to reviewed course attachment identities and checks download permission/version; the Google grant itself is broader than those app rules. Leave it off to collect course text and references and import permitted downloads manually.
- UVEC automation requires a school-approved restricted read-only service/token. Manual imports work without one. The app does not harvest browser cookies, bypass login or assume school authorization.
- Collection catalogs retain account/course identifiers, course text, reviewed choices, source references, versions, destination mappings, download receipts and job history to enable review, recovery and duplicate/version handling. Optional daily collection runs while the app is open and stays within approved courses/exclusions; it can be disabled.

## Transfers and sharing

Optional collection communicates directly from your device to fixed Google identity/Classroom/Drive endpoints or the configured school service using HTTPS. Google receives OAuth and API requests; the school receives requests for its service. Neither a token refresh nor a document download is an anonymous request. No school data is sent to the developer by the app. We do not sell Google user data, use it for ads, transfer it to data brokers, or use it to train generalized AI models. Archive Search's use and transfer of information received from Google APIs will adhere to the Google API Services User Data Policy, including its Limited Use requirements. This commitment is not a claim that Google has verified the app.

Support diagnostics are locally previewed and exported only when requested; the built-in sanitized report omits tokens, raw identifiers, document text, account labels and file paths. Review any report or screenshot yourself before sharing. Do not email credentials or real student materials. If you voluntarily send support correspondence, it is used to respond or investigate the issue; request deletion through the contact above. Email providers, legal retention requirements and your copies/backups may limit deletion outside the app.

## Storage and protection

Runtime profile data ordinarily lives under `%APPDATA%\school-materials-manager\data` (the host may redirect AppData). Google refresh grants, school tokens, configured connection details and schedule settings in `connections.bin` use Electron safeStorage/Windows account encryption. No plaintext token fallback is used. Access tokens can exist in process memory. This source repository contains no bundled Desktop OAuth client. If you configure one, its public-client fields identify the native application; they are not a user's refresh token or a confidential server credential.

**Documents, collection catalogs, indexes, previous/interrupted indexes, settings/history, paths and saved items are plaintext.** A previous successful index is intentionally retained for recovery during normal rebuilds. Removing a result from search or replacing an index is not erasure of every stored byte. The portable executable's folder is not the entire data profile. Windows account encryption does not isolate malware running as the same Windows user. Use device encryption, appropriate Windows account access and separate accounts on shared devices. No app can guarantee protection from an already compromised computer.

## Retention, disconnect and deletion

Data stays locally until you remove it; ordinary disconnect/uninstall does not erase collected files or search/catalog data. Disconnect removes the selected local connection and its schedule, clears access caches and attempts Google revocation. A failed revocation is reported: remove Archive Search under your Google account's third-party permissions and retry/reconnect only when appropriate. Disconnecting UVEC requires school-side token revocation through the portal/administrator. Local removal cannot prove remote revocation while offline.

Settings → **Forget archive / Clear local data** provides four unchecked scopes: all app-owned active/previous/interrupted indexes plus archive settings/indexing history; all saved searches/bookmarks across archives; all collection metadata/review/history/mappings and app download staging; and review of individual verified managed copies in the current archive. Review exact filenames, select each copy, then separately confirm in Windows. Cancellation removes nothing. Confirmed removal disables daily collection and clears in-memory collection context. Connected accounts/tokens remain until you use Disconnect separately. Window geometry is retained.

The workflow closes owned databases before removing their files and reopens the remaining app state. It preserves original files, untracked files, unselected copies, edited/missing/linked/unverifiable managed copies and directory names. Copies in another archive require selecting that archive first, while its catalog still exists. Removing the catalog first loses automatic ownership tracking; review retained copies before that choice. Failed removals are reported and may require another review. A corrupt/unreadable collection catalog is preserved for recovery rather than guessed at. Unknown files and unverified archive staging remain for manual review.

File deletion is not guaranteed forensic erasure from SSDs, filesystem snapshots, external backups, email or cloud-sync version history. Archive Search does not erase originals, wipe drives or manage external copies. Review those services and devices separately. Contact the publisher for help with the app's local profile or a privacy request; we cannot remotely delete your local files.

## Testing status, permission and changes

No verified shared Google application or consented real-course pilot is supplied. Configure your own OAuth project and follow its audience, policy-URL, scope and applicable verification requirements. Projects using **External / Testing** can have test-user restrictions and expiring refresh grants. School administrator allowance, your own access permission and permission to retain materials are independent requirements. A configured build offered to other users needs the corresponding consent-screen setup and permitted exact-package validation; publishing this source alone does not complete those steps. UVEC stays manual without an approved restricted service.

Material changes to data access/retention require an updated policy and appropriate notice/consent before use. Contact **geogabaisen@gmail.com** for privacy questions, deletion help or policy changes.

References: [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), [Drive scope requirements](https://developers.google.com/workspace/drive/api/guides/api-specific-auth), [Classroom authorization](https://developers.google.com/workspace/classroom/guides/auth).
