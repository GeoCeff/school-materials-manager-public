import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, normalize, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { extractFile, getRawHeader, listPackage, statFile } from '@electron/asar';
import { FuseVersion, FuseV1Options, FuseState, getCurrentFuseWire } from '@electron/fuses';
import { NtExecutable, NtExecutableResource } from 'resedit';

export const packageFuses = {
  version: FuseVersion.V1, strictlyRequireAllFuses: true,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
  // ponytail: keep file:// module/font loading compatible; a custom protocol is a separate migration.
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: true,
  [FuseV1Options.WasmTrapHandlers]: true,
};
const hash = value => createHash('sha256').update(value).digest('hex');

export async function verifyPackage(directory, source = resolve('.')) {
  const exe = join(directory, 'school-materials-manager.exe');
  const archive = join(directory, 'resources', 'app.asar');
  const wire = await getCurrentFuseWire(exe);
  assert.equal(wire.version, packageFuses.version);
  const fuses = {};
  for (const [option, enabled] of Object.entries(packageFuses).filter(([key]) => /^\d+$/.test(key))) {
    assert.equal(wire[option], enabled ? FuseState.ENABLE : FuseState.DISABLE, `Unexpected fuse: ${FuseV1Options[option]}`);
    fuses[FuseV1Options[option]] = enabled;
  }
  const binary = await readFile(exe);
  const resources = NtExecutableResource.from(NtExecutable.from(binary, { ignoreCert: true }));
  const entries = resources.entries.filter(entry => entry.type === 'INTEGRITY' && entry.id === 'ELECTRONASAR');
  assert.equal(entries.length, 1, 'Executable must contain one embedded ASAR integrity resource');
  const integrity = JSON.parse(Buffer.from(entries[0].bin).toString('utf8'));
  const headerSha256 = hash(getRawHeader(archive).headerString);
  assert.deepEqual(integrity, [{ file: 'resources\\app.asar', alg: 'SHA256', value: headerSha256 }]);
  const paths = listPackage(archive).map(path => path.replaceAll('\\','/'));
  assert.ok(!paths.some(path => /^\/(?:src|tests|scripts|output|out|\.git)(?:\/|$)/.test(path) || /^\/dist\/tests(?:\/|$)/.test(path) || /(?:connections.*\.bin|client_secret.*\.json|google-client.*\.json|uvec-token.*\.json|\.sqlite(?:-.*)?)$/i.test(path)), 'Private/development paths in package');
  const runtime = {};
  async function compare(relative) {
    for (const entry of await readdir(join(source, relative), { withFileTypes: true })) {
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await compare(path);
      else {
        const original = await readFile(join(source, path));
        const packed = extractFile(archive, normalize(path));
        assert.equal(hash(packed), hash(original), `Packaged runtime differs from checked build: ${path}`);
        runtime[path] = hash(packed);
      }
    }
  }
  for (const path of ['dist/src', 'dist/ui', 'dist/assets']) await compare(path);
  for (const path of paths.filter(path => /^\/dist\/(?:src|ui|assets)\//.test(path))) {
    if (!statFile(archive,normalize(path.slice(1))).files) assert.ok(Object.hasOwn(runtime,path.slice(1)), `Unexpected packaged runtime file: ${path}`);
  }
  const unpacked = {};
  for (const path of paths) if (/\.(?:node|dll)$/i.test(path) || path === '/dist/assets/parser-host.exe') {
    const info = statFile(archive,normalize(path.slice(1))); assert.equal(info.unpacked,true,`Native library must be unpacked: ${path}`);
    const bytes = await readFile(join(`${archive}.unpacked`,path.slice(1)));
    assert.equal(hash(bytes),hash(await readFile(join(source,path.slice(1)))),`Native library differs from installed dependency: ${path}`);
    unpacked[path.slice(1)] = hash(bytes);
  }
  assert.ok(Object.keys(unpacked).length > 0, 'Native canvas library missing');
  const hostManifest = JSON.parse(extractFile(archive, normalize('dist/assets/parser-host.sha256')));
  assert.equal(hostManifest.sha256, unpacked['dist/assets/parser-host.exe'], 'Parser supervisor must match its ASAR-sealed digest');
  assert.equal(JSON.parse(extractFile(archive, 'package.json')).main, 'dist/src/desktop/entry.js', 'Parser mode must precede desktop initialization');
  let publicDesktopClient = false;
  if (paths.includes('/dist/assets/desktop-oauth.json')) {
    const configuration = JSON.parse(extractFile(archive,normalize('dist/assets/desktop-oauth.json')));
    assert.deepEqual(Object.keys(configuration),['installed']);
    assert.ok(configuration.installed && Object.keys(configuration.installed).every(key => ['client_id','client_secret'].includes(key)));
    assert.equal(typeof configuration.installed.client_id,'string'); publicDesktopClient = true;
  }
  const metadata = JSON.parse(extractFile(archive, 'package.json'));
  const expected = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  assert.equal(metadata.version, expected.version);
  assert.equal(metadata.license, 'MIT');
  assert.equal(hash(extractFile(archive, 'LICENSE')), hash(await readFile(join(source, 'LICENSE'))), 'Packaged app license differs from source');
  const documents = {};
  for (const name of ['LICENSE.archive-search.txt', 'THIRD_PARTY_NOTICES.txt', 'INTERACTION_GUIDELINES.md', 'COLLECTION_SETUP.md', 'PRIVACY.md', 'SECURITY.md', 'RELEASE_CHECKLIST.md', 'licenses/native/THIRD_PARTY_NOTICES.txt', 'licenses/native/SOURCE_MANIFEST.json']) {
    const bytes = await readFile(join(directory, name));
    assert.equal(hash(bytes), hash(await readFile(join(source, name === 'LICENSE.archive-search.txt' ? 'LICENSE' : name))), `Packaged document differs from reviewed source: ${name}`);
    documents[name] = hash(bytes);
  }
  const nativeManifest = JSON.parse(await readFile(join(directory, 'licenses/native/SOURCE_MANIFEST.json'), 'utf8'));
  assert.equal(nativeManifest.canvasVersion, expected.dependencies['@napi-rs/canvas']);
  assert.equal(nativeManifest.sbomSha256, hash(await readFile(join(source, 'node_modules/@napi-rs/canvas-win32-x64-msvc/sbom.cdx.json'))));
  const covered = nativeManifest.components.filter(component => component.licenses.some(license => license.expression === 'MPL-2.0'));
  assert.deepEqual(nativeManifest.coveredSources.map(item => item.file).sort(), covered.map(item => `${item.name}-${item.version}.crate`).sort());
  const coveredSources = {};
  for (const item of nativeManifest.coveredSources) {
    assert.match(item.file, /^[a-z0-9-]+-\d[\w.+-]*\.crate$/);
    const name = `licenses/native/${item.file}`;
    const digest = hash(await readFile(join(directory, name)));
    assert.equal(digest, item.sha256); assert.equal(digest, hash(await readFile(join(source, name))));
    coveredSources[name] = digest;
  }
  const instructions = await readFile(join(directory, 'README.txt'), 'utf8');
  assert.ok(instructions.startsWith(`Archive Search ${expected.version} - unsigned experimental Windows x64 build`), 'Portable instructions must identify the current version and channel');
  for (const name of [...Object.keys(documents), 'LICENSE', 'LICENSES.chromium.html']) {
    assert.ok(instructions.includes(name), `Portable instructions omit ${name}`);
    assert.ok((await readFile(join(directory, name))).length > 0, `Missing license/document: ${name}`);
  }
  return { passed: true, version: metadata.version, electron: expected.devDependencies.electron, fuses, headerSha256,
    executableSha256: hash(binary), asarSha256: hash(await readFile(archive)), publicDesktopClient, unpacked, documents, coveredSources, runtimeFiles: Object.keys(runtime).length, runtime };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.ok(process.argv[2], 'Pass the packaged application directory');
  const report = await verifyPackage(resolve(process.argv[2]));
  console.log(JSON.stringify({ ...report, runtime: undefined }, null, 2));
}
