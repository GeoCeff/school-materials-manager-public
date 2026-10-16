async (page) => {
  await page.addInitScript(() => {
    const options = {year:[],semester:[],subject:[],type:[]};
    const failure = () => new Error('Synthetic failure ' + 'unbrokenpath'.repeat(100) + ' Retry or choose another folder.');
    window.readabilityState = 'startup-error';
    window.archive = {demo:false,initialTheme:'light',
      status:async()=>{if(window.readabilityState==='startup-error')throw failure();return{root:'C:\\Synthetic archive',available:true,canRefresh:true,theme:'light',ocr:false,job:null,problem:null,files:0,passages:0,lastScan:null,coverage:{indexed:0,partial:0,stale:0,failed:0,noText:0},options};},
      progress:()=>()=>{},failure:()=>()=>{},options:async()=>options,
      browse:async()=>{if(window.readabilityState==='browse-error')throw failure();return{folder:'',entries:[],total:0,nextOffset:null,limited:false};},
      saved:async()=>{throw failure();},clearCancel:async()=>{}
    };
  });
  await page.reload();
  const fit = async name => {
    await page.getByText(/Synthetic failure/).waitFor();
    if (!await page.evaluate(() => document.documentElement.scrollWidth<=innerWidth+1 && [...document.querySelectorAll('.notice,[role=alert]')].every(el=>el.scrollWidth<=el.clientWidth+1))) throw new Error(name+' overflowed');
  };
  for (const width of [560,1360]) {
    await page.setViewportSize({width,height:700});
    await fit('Startup error');
  }
  await page.evaluate(()=>{window.readabilityState='browse-error';});
  await page.getByRole('button',{name:'Retry',exact:true}).click();
  await fit('Files error');
  await page.evaluate(()=>{window.readabilityState='success';});
  await page.getByRole('region',{name:'Archive files'}).getByRole('button',{name:'Retry',exact:true}).click();
  await page.getByRole('heading',{name:'No indexed files here yet.'}).waitFor();
  const contrasts = [];
  for (const theme of ['light','dark']) {
    await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;},theme);
    const minimum = await page.evaluate(() => {
      const luminance = color => {const rgb=color.match(/[\d.]+/g).slice(0,3).map(Number).map(n=>n/255).map(n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4);return .2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2];};
      const bg=luminance(getComputedStyle(document.body).backgroundColor);
      return Math.min(...[...document.querySelectorAll('.search-input,select')].filter(el=>el.getClientRects().length).map(el=>{const border=luminance(getComputedStyle(el).borderTopColor);return(Math.max(bg,border)+.05)/(Math.min(bg,border)+.05);}));
    });
    if(minimum<3)throw new Error(theme+' input boundary contrast was '+minimum);
    contrasts.push({theme,minimum});
  }
  await page.setViewportSize({width:560,height:520});
  await page.getByRole('button',{name:'Saved',exact:true}).click();
  await fit('Saved error');
  return {passed:true,longStartupBrowseSavedErrorsWrap:true,actionableRetryVisible:true,formBoundaryContrast:contrasts};
}
