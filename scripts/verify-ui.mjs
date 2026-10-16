import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ArchiveService } from '../dist/src/core/index.js';
import { createDemo } from '../dist/src/demo.js';

assert.ok(process.argv[2], 'Pass an already-installed playwright/index.mjs path. Run npm run build first.');
const { _electron, chromium }=await import(pathToFileURL(resolve(process.argv[2])).href);
const output=resolve('output/playwright');await mkdir(output,{recursive:true});
const sandbox=await mkdtemp(join(output,'ui-qa-'));
const root=join(sandbox,'school-materials-manager-demo-archive');
await createDemo(root);
const service=new ArchiveService(join(sandbox,'school-materials-manager-demo','data'));
await service.init();await service.prepareRoot(root);await service.start('import');await service.whenIdle();await service.close();
const bootstrap=join(sandbox,'main.mjs');
await writeFile(bootstrap,`import {app} from 'electron';\napp.setPath('appData',${JSON.stringify(sandbox)});\nawait import(${JSON.stringify(pathToFileURL(resolve('dist/src/desktop/main.js')).href)});\n`);
const report={passed:false,isolated:true,checks:{},errors:[]};
const run=async(page,name)=>{const code=await readFile(`tests/ui/${name}.js`,'utf8');report.checks[name]=await(new Function(`return (${code})`))()(page);console.log(name,JSON.stringify(report.checks[name]));};
const app=await _electron.launch({executablePath:resolve('node_modules/electron/dist/electron.exe'),args:[bootstrap,'--demo','--ui-test'],colorScheme:null});
let page;
try{
  assert.equal(await app.evaluate(({app})=>app.getPath('appData')),sandbox);
  page=await app.firstWindow();await page.locator('.appearance-trigger').waitFor();
  assert.equal((await page.evaluate(()=>window.archive.status())).root,root);
  page.on('pageerror',error=>report.errors.push(error.message));
  for(const name of ['preview-regression','accessibility-check','release-features','appearance-motion'])await run(page,name);
  const browser=await chromium.launch({channel:'chrome',headless:true,args:['--allow-file-access-from-files']});
  try{for(const name of ['appearance-races','saved-recovery','readability']){const mock=await browser.newPage();await mock.goto(pathToFileURL(resolve('dist/ui/index.html')).href);await run(mock,name);await mock.close();}}finally{await browser.close();}
  assert.deepEqual(report.errors,[]);report.passed=true;
}catch(error){report.error=error.stack;await page?.screenshot({path:join(output,'ui-qa-failure.png')}).catch(()=>{});throw error;}
finally{await app.close();await writeFile(join(output,'ui-qa.json'),JSON.stringify(report,null,2));}
