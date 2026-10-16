async (page) => {
  // Run in an isolated browser against the built renderer, never against a user's archive.
  await page.addInitScript(() => {
    const pending = []; const calls = []; let stored = 'system'; let native = 'system'; let progress; let root = null; let bookmarkResolve;
    const options = {year:[],semester:[],subject:[],type:[]};
    const preview = {fileId:'waiting.txt',passageId:1,type:'Text',relativePath:'waiting.txt',text:'An original deferred bookmark fixture.',startLine:1,endLine:1,availability:'available',canOpen:false};
    const status = () => ({theme:stored,root,available:!!root,canRefresh:!!root,job:null,ocr:false,problem:null,files:0,passages:0,lastScan:null,coverage:{indexed:0,partial:0,stale:0,failed:0,noText:0},options});
    const staleStatus = () => progress?.({state:'completed',processed:0,total:0,counts:{failed:0},errors:[]});
    window.archive = {initialTheme:'system',demo:true,status:async()=>status(),appearance:async value=>{native=value;},theme:value=>new Promise((resolve,reject)=>{calls.push(value);pending.push({value,resolve,reject});}),progress:callback=>{progress=callback;return()=>{};},failure:()=>()=>{},
      options:async()=>options,browse:async()=>({folder:'',entries:[],total:0,nextOffset:null,limited:false}),saved:async()=>[{id:'synthetic-bookmark',kind:'bookmark',title:'waiting.txt',root,startLine:1}],preview:async()=>preview,openBookmark:()=>new Promise(resolve=>{bookmarkResolve=resolve;})};
    window.themeHarness = {pending,calls,get stored(){return stored;},get native(){return native;},resolve(){const next=pending.shift();stored=next.value;next.resolve();},reject(){pending.shift().reject(new Error('Simulated disk full'));},staleStatus,enableLibrary(){root='C:\\Synthetic fixture';staleStatus();},get bookmarkPending(){return !!bookmarkResolve;},resolveBookmark(){bookmarkResolve(preview);}};
  });
  await page.reload();
  await page.evaluate(() => {
    themeHarness.mismatches = [];
    new MutationObserver(() => {
      if (document.querySelector('.appearance-trigger')?.textContent.includes('System') && document.documentElement.dataset.theme !== (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) themeHarness.mismatches.push(document.documentElement.dataset.theme);
    }).observe(document.documentElement, {attributes:true,attributeFilter:['data-theme']});
  });
  await page.emulateMedia({colorScheme:'dark',reducedMotion:'reduce'});
  const check = (condition,message)=>{if(!condition)throw new Error(message);};
  const choose=async value=>{await page.getByRole('button',{name:/^Appearance:/}).click();await page.locator(`[data-choice=${value}]`).click();};
  const current=()=>page.evaluate(()=>({stored:themeHarness.stored,native:themeHarness.native,calls:[...themeHarness.calls],pending:themeHarness.pending.length,label:document.querySelector('.appearance-trigger').textContent,palette:document.documentElement.dataset.theme,osDark:matchMedia('(prefers-color-scheme: dark)').matches}));
  await choose('light'); await choose('dark'); await choose('system');
  let state=await current();check(state.calls.join() === 'light' && state.label.includes('System') && state.native === 'system', 'Rapid choice was blocked or writes overlapped');
  await page.evaluate(()=>themeHarness.resolve()); await page.waitForFunction(()=>themeHarness.pending[0]?.value === 'system');
  await page.evaluate(()=>themeHarness.resolve()); await page.waitForFunction(()=>document.querySelector('.theme-control [role=status]').textContent !== 'Saving appearance.');
  state=await current();check(state.stored === 'system' && state.palette === 'dark', 'Latest choice did not persist: '+JSON.stringify(state));
  await choose('light'); await page.evaluate(()=>themeHarness.staleStatus());
  state=await current();check(state.palette === 'light' && state.label.includes('Light'), 'Stale status reverted pending choice');
  await choose('dark'); await page.evaluate(()=>themeHarness.reject()); await page.waitForFunction(()=>themeHarness.pending[0]?.value === 'dark');
  check(!await page.getByRole('alert').count(), 'An older failure rolled back a newer choice');
  await page.evaluate(()=>themeHarness.resolve()); await page.waitForTimeout(20);
  state=await current();check(state.stored === 'dark' && state.native === 'dark' && state.palette === 'dark', 'Newer save lost');
  await choose('light'); await page.evaluate(()=>themeHarness.reject()); await page.getByRole('alert').waitFor();
  state=await current();check(state.label.includes('Dark') && state.stored === 'dark' && state.native === 'dark' && state.palette === 'dark', 'Latest failure did not restore confirmed choice');
  await choose('light'); check(!await page.getByRole('alert').count(), 'Retry retained the previous save error'); await page.evaluate(()=>themeHarness.resolve()); await page.waitForTimeout(20);
  state=await current();check(state.stored === 'light' && state.palette === 'light', 'Retry did not recover');
  const count=state.calls.length;await choose('light');state=await current();check(state.calls.length === count,'Reselection wrote settings');
  check(await page.evaluate(()=>themeHarness.mismatches.length) === 0, 'System briefly applied an obsolete OS palette');
  await page.getByRole('button',{name:/^Appearance:/}).click();
  await page.evaluate(()=>themeHarness.enableLibrary());
  await page.waitForFunction(()=>{const popup=document.querySelector('#appearance-menu').getBoundingClientRect();const trigger=document.querySelector('.appearance-trigger').getBoundingClientRect();return !!document.querySelector('#saved-button') && Math.abs(popup.right-trigger.right)<2;});
  await page.getByRole('button',{name:'Saved',exact:true}).click();
  await page.locator('.saved-item').filter({hasText:'waiting.txt'}).click(); await page.waitForFunction(()=>themeHarness.bookmarkPending);
  await page.keyboard.press('Escape'); await page.evaluate(()=>themeHarness.resolveBookmark()); await page.waitForTimeout(40);
  check(!await page.locator('.source-title').count() && !await page.locator('.workspace').evaluate(el=>el.classList.contains('preview-open')), 'Closed Saved dialog dispatched a delayed bookmark');
  check(await page.getByRole('button',{name:'Saved',exact:true}).evaluate(el=>el===document.activeElement), 'Delayed bookmark stole focus after close');
  await page.setViewportSize({width:280,height:260});
  await page.getByRole('button',{name:/^Appearance:/}).click(); await page.evaluate(()=>window.scrollTo(0,280));
  await page.waitForFunction(()=>!document.querySelector('#appearance-menu').matches(':popover-open'));
  check(await page.locator('#appearance-menu').evaluate(el=>el.inert), 'Offscreen anchor left interactive menu content');
  return {passed:true,serializedCoalescedWrites:true,staleStatusIgnored:true,olderFailureIgnored:true,latestFailureRestored:true,retry:true,reselection:true,headerReposition:true,scrolledAnchorDismissal:true,closedSavedCallbackIgnored:true};
}
