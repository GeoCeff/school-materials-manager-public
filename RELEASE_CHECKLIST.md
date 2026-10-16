# Archive Search 0.3.0 source release

Prepared October 16, 2026 (Asia/Manila). Scope: a personal, experimental Windows desktop project shared as source under [MIT](LICENSE). This release includes no executable download, Google OAuth client configuration, credentials or real school materials. It does not claim school endorsement or verified live-provider support.

## Source publication

These checks apply to the public source snapshot. They do not require completing every possible deployment or hardware test.

- [x] Select public source sharing under MIT as the intended scope.
- [x] Include the application license, retain dependency notices and review source/asset redistribution rights.
- [x] Review the exact public files for secrets, private paths, school content and unrelated material. Keep runtime data, OAuth configuration and local reports out of Git.
- [x] Build and run tests from the public snapshot using its lockfile; record the actual results below.
- [x] Check documentation links, setup instructions and experimental-feature disclosures.
- [ ] Review the final Git tree, publish to the intended public repository and verify its remote commit.

Fresh public-snapshot validation on the Windows 11 x64 development host: **npm ci succeeded, 108/108 automated tests passed with zero skips, and all seven UI suites passed**. The fresh install reported zero dependency advisories. This validates the reviewed source on that host; it does not certify a clean Windows device or downloadable binary.

Earlier rc4 development checks additionally exercised collection/source-switch review, byte and storage thresholds, failed writes, stale reviews, Saved races, PDF limits and finite resource cycles. Those remain scoped historical development results.

## Reproduce source checks

Use Windows x64, Node.js 24.14.1 or newer, Windows PowerShell 5.1 and a compatible .NET Framework compiler/runtime. UI checks use an already-installed Playwright module and Chrome.

```powershell
npm ci
npm test
npm run smoke
$playwrightModule = 'C:/path/to/installed/playwright/index.mjs'
node scripts/verify-ui.mjs $playwrightModule
node scripts/verify-collection-ui.mjs $playwrightModule
node scripts/verify-security-ui.mjs $playwrightModule
node scripts/verify-pdf-security.mjs $playwrightModule
.\scripts\test-release-tools.ps1
```

The runners use isolated synthetic profiles. Keep real archives, profiles and live accounts out of tests. Record dependency audits separately from functional checks. Renderer offline emulation and accessibility trees do not establish whole-device offline behavior or audible speech.

## Known limits

- Windows 11 x64 is the tested development environment. Clean Windows without Node/Office, Windows 10, ARM64, native hardware/DPI/remote-session behavior and audible Narrator/NVDA trials remain unverified.
- Current development checks do not cover a physically disconnected clean device, an overnight soak, exhausted physical volumes, every cross-user ACL environment or an exhaustive hostile parser corpus.
- PDF parsing uses Windows Job Object allocation limits and fails closed without containment. This is not a filesystem/network sandbox or a guarantee against every native parser vulnerability. OCR rotation and language availability remain limited.
- Profile download staging has bounded write-error cleanup but no separate free-space reserve preflight. The collection catalog budget counts retained recorded versions, not unmanaged/edited files or previous indexes.
- Indexes contain local unencrypted document text. Ordinary removal cannot guarantee erasure from SSDs, backups or sync history. Disconnect retains files and indexes.
- Google/UVEC live access and real-course behavior have not been validated. No publisher OAuth client is supplied; local search and manual import need no account. UVEC automatic access requires a school-approved restricted service.

These limits remain visible while the source is shared. Revisit the affected checks before claiming broader compatibility, unattended reliability, accessibility or provider support. Fix any discovered credential leak, source-file damage, unauthorized access, out-of-scope deletion or failed containment before sharing an affected path.

## Optional later portable release

A downloadable app is a separate decision. Signing is optional for an experimental preview; an unsigned build must say so plainly, and Windows warnings must not be treated as a test to bypass. A checksum identifies bytes but does not authenticate the publisher.

For each future binary:

- Build into a new output directory and retain the exact source commit, version, ZIP SHA-256 and limitations.
- Validate packaged runtime/helper/document hashes, Electron fuses, ASAR integrity and tamper rejection.
- Test a fresh extraction and cold starts. Run the intended compatibility, clean-device, physical-offline and audible-reader checks before making those claims.
- Include policies, notices, backup/recovery instructions and a support route. Review the final artifact again if code, configuration, packaged documents or signatures change.

Example local package checks after `npm run build`:

```powershell
node scripts/package.mjs --out=out/source-preview-0.3.0
node scripts/verify-package.mjs out/source-preview-0.3.0/school-materials-manager-win32-x64
node scripts/test-package-security.mjs out/source-preview-0.3.0/school-materials-manager-win32-x64 out/source-preview-security-0.3.0
```

After archiving the complete folder and computing its actual SHA-256:

```powershell
.\scripts\verify-portable.ps1 -ArchiveZip '<new-zip-path>' -ExpectedSha256 '<actual-64-hex-digest>' -OutputDirectory out/source-preview-extraction-0.3.0
```

The verifier never disconnects the computer. Add `-RequireOffline` only in an arranged disconnected environment and `-RequireCleanMachine` only on the intended clean test device. Restricted PATH checks alone do not establish a clean installation. No public binary is supplied or validated by this source release record.

## Optional later live-provider use

Before a real Google/UVEC pilot, authorize the actual account, course, scopes and retention, and obtain the school allowance appropriate to that access. Compare inventory, copied bytes and provenance; verify unchanged course state and revoke/disconnect/offline/reconnect behavior. Keep UVEC manual without an approved restricted service.

A generally available publisher-configured Google connection additionally needs matching public policy/consent identity and applicable Google verification for its actual scopes. Optional broad Drive read access remains off by default. Mocked tests and OAuth registration do not establish those approvals. Source publication does not claim or complete this separate work.

## Recovery and support

Back up `%APPDATA%\school-materials-manager` and your archive separately before upgrades or downgrades. Rebuild replaces the disposable index while Saved and collection records persist separately. Open newer index/catalog versions only with a compatible app.

Read [PRIVACY.md](PRIVACY.md), [SECURITY.md](SECURITY.md) and [COLLECTION_SETUP.md](COLLECTION_SETUP.md) for data and permission boundaries. Contact: geogabaisen@gmail.com. Reports should include the version, Windows version and minimal synthetic reproduction; never send tokens, student records or real coursework.
