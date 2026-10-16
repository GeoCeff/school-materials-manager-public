import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ArchiveService } from '../dist/src/core/index.js';
import { compressedImagePdf } from '../dist/tests/pdf-fixtures.js';
import { createDemo } from '../dist/src/demo.js';

assert.ok(process.argv[2], 'Pass an installed playwright/index.mjs path. Build first.');
const { _electron } = await import(pathToFileURL(resolve(process.argv[2])).href);
const sandbox = await mkdtemp(join(tmpdir(), 'archive-pdf-ui-'));
const root = join(sandbox, 'school-materials-manager-demo-archive');
const data = join(sandbox, 'school-materials-manager-demo', 'data');
await createDemo(root);
const source = join(root, 'bounded-image.pdf');
await writeFile(source, await compressedImagePdf(true));
const hash = async () => createHash('sha256').update(await readFile(source)).digest('hex');
const before = await hash();
const store = new ArchiveService(data);
try { await store.init(); await store.setOcr(true); await store.prepareRoot(root); await store.start('import'); await store.whenIdle(); }
finally { await store.close(); }
const bootstrap = join(sandbox, 'main.mjs');
await writeFile(bootstrap, `import {app} from 'electron';\napp.setPath('appData',${JSON.stringify(sandbox)});\nawait import(${JSON.stringify(pathToFileURL(resolve('dist/src/desktop/main.js')).href)});\n`);
const output = resolve('output/playwright'); await mkdir(output, { recursive: true });
const report = { passed: false, isolated: true, errors: [] };
const app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [bootstrap, '--demo', '--ui-test'] });
try {
  assert.equal(await app.evaluate(({ app }) => app.getPath('appData')), sandbox);
  const page = await app.firstWindow(); page.on('pageerror', error => report.errors.push(error.message));
  const sourcePane = page.getByRole('complementary', { name: 'Selected passage' });
  await page.getByRole('searchbox', { name: 'Search your archive' }).fill('safe embedded marker');
  await page.getByRole('button').filter({ hasText: 'bounded-image.pdf' }).first().click();
  await sourcePane.getByText(/Some PDF image content was skipped/).waitFor();
  await sourcePane.getByRole('button', { name: 'PDF page', exact: true }).click();
  await sourcePane.locator('.pdf-canvas img').waitFor();
  await sourcePane.getByRole('button', { name: 'Previous PDF page' }).click();
  await sourcePane.getByText(/Its preview is unavailable; the original file is unchanged/).waitFor();
  assert.equal(await sourcePane.locator('.pdf-canvas img').count(), 0);
  await sourcePane.getByRole('button', { name: 'Retry page', exact: true }).click();
  await sourcePane.getByRole('button', { name: 'Retry page', exact: true }).waitFor({ state: 'hidden' });
  await sourcePane.getByText(/Its preview is unavailable; the original file is unchanged/).waitFor();
  assert.equal(await hash(), before); assert.deepEqual(report.errors, []);
  await page.screenshot({ path: join(output, 'pdf-security-unavailable.png'), animations: 'disabled' });
  report.passed = true; report.checks = ['persisted partial warning', 'valid page renders', 'oversized image unavailable through real IPC', 'retry stays unavailable', 'original unchanged'];
} catch (error) { report.error = error.stack; throw error; }
finally { await app.close(); await writeFile(join(output, 'pdf-security.json'), JSON.stringify(report, null, 2)); await rm(sandbox, { recursive: true, force: true }); }
console.log(JSON.stringify(report));
