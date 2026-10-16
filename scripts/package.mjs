import { packager } from '@electron/packager';
import { access, copyFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { resolve, sep } from 'node:path';
import { flipFuses } from '@electron/fuses';
import { packageFuses, verifyPackage } from './verify-package.mjs';
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const out = process.argv.find(value => value.startsWith('--out='))?.slice(6) || `out/release-${version}`;
if (!resolve(out).startsWith(resolve('out') + sep)) throw new Error('Package output must be a new directory inside out/.');
try { await access(out); throw new Error(`${out} exists. Preserve it before building another release.`); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const canvas = createCanvas(256, 256); canvas.getContext('2d').drawImage(await loadImage(await readFile('assets/icon.svg')), 0, 0);
const png = canvas.toBuffer('image/png');
// Windows ICO supports an embedded PNG; one 256px image covers taskbar and Explorer scaling.
const ico = Buffer.alloc(22); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4); ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12); ico.writeUInt32LE(png.length, 14); ico.writeUInt32LE(22, 18);
await mkdir('dist/assets', {recursive:true}); await writeFile('dist/assets/icon.ico', Buffer.concat([ico, png]));
const zip = process.argv.find(value => value.startsWith('--electron-zip-dir='))?.split('=').slice(1).join('=');
const directories = await packager({dir:'.', name:'school-materials-manager', platform:'win32', arch:'x64', out,
  asar:{unpack:'**/*.{node,dll,exe}'}, icon:'dist/assets/icon.ico', ...(zip ? {electronZipDir:zip} : {}),
  // Include the runtime and production dependencies only; local evidence and future root files stay outside the package.
  ignore:path => path !== '' && !/^\/(?:node_modules(?:\/|$)|dist(?:\/(?:src|ui|assets)(?:\/|$)|$)|package\.json$|LICENSE$|THIRD_PARTY_NOTICES\.txt$)/.test(path)});
for (const directory of directories) {
  await flipFuses(`${directory}/school-materials-manager.exe`, packageFuses);
  await writeFile(`${directory}/README.txt`, `Archive Search ${version} - unsigned experimental Windows x64 build

Extract the entire ZIP into a writable folder and run school-materials-manager.exe.
Keep all extracted files together. No Node.js, Office or development server is needed.
Tested host: Windows 11 x64. PDF parsing needs compatible Windows/.NET Job support.
Clean-device, physical-offline and audible screen-reader checks remain open.

1. Choose your archive folder, review it, then select Start indexing.
2. Search for words or an "exact phrase"; filter by year, semester, subject or type.
3. Select a result for its text and page, paragraph, slide or line location.
4. Refresh after changing files. Enable optional local Windows OCR in Settings.
5. Use Saved for searches/bookmarks. Collect can copy permitted manual downloads.

Search preserves original files. Collection writes managed copies under Collected.
Settings offers separately reviewed removal of app data and selected verified copies.
Disconnect is separate from deleting local files. Back up your profile before upgrades.
Profile: %APPDATA%\\school-materials-manager (including data and window preferences).

Search/PDF/OCR use local assets. Optional online collection requires permission.
Google is External / Testing; registration does not establish live-school approval.
UVEC uses manual import unless the school supplies an approved restricted service.
Archive Search source is MIT-licensed; see LICENSE.archive-search.txt.
This unsigned build does not authenticate its publisher.

Read these files beside the executable:
COLLECTION_SETUP.md - source setup, permissions and permitted manual imports
PRIVACY.md - data access, plaintext storage, retention, disconnect and deletion
SECURITY.md - protection boundaries, updates and private vulnerability reporting
RELEASE_CHECKLIST.md - validation procedure and outstanding release gates
INTERACTION_GUIDELINES.md - keyboard and appearance behavior
THIRD_PARTY_NOTICES.txt, LICENSE, LICENSES.chromium.html - bundled licenses
LICENSE.archive-search.txt - Archive Search's MIT license
licenses/native/THIRD_PARTY_NOTICES.txt - native canvas component notices
licenses/native/SOURCE_MANIFEST.json - exact upstream source identities
licenses/native/*.crate - unmodified MPL-covered source packages

Support and privacy contact: geogabaisen@gmail.com
Do not send credentials, real coursework or student records.
`);
  for (const name of ['THIRD_PARTY_NOTICES.txt', 'INTERACTION_GUIDELINES.md', 'COLLECTION_SETUP.md', 'PRIVACY.md', 'SECURITY.md', 'RELEASE_CHECKLIST.md']) await copyFile(name, `${directory}/${name}`);
  await copyFile('LICENSE', `${directory}/LICENSE.archive-search.txt`);
  await cp('licenses/native', `${directory}/licenses/native`, { recursive: true, errorOnExist: true, force: false });
  const security = await verifyPackage(directory);
  await writeFile(`${out}/package-security.json`, JSON.stringify(security, null, 2) + '\n');
}
console.log(JSON.stringify({version,directories}));
