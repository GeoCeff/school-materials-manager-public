async (page) => {
  // Isolated built-renderer harness only; no user archive or saved.json is read.
  await page.addInitScript(() => {
    const root = 'C:\\Synthetic saved recovery';
    const options = {year:[],semester:[],subject:[],type:[]};
    let loads = 0, failRemove = true;
    let items = ['First search','Second search'].map((title,index) => ({id:String(index),kind:'search',root,title,query:title,filters:{}}));
    window.archive = {initialTheme:'system',demo:true,
      status:async()=>({root,theme:'system',available:true,canRefresh:true,job:null,ocr:false,problem:null,files:0,passages:0,lastScan:null,coverage:{indexed:0,partial:0,stale:0,failed:0,noText:0},options}),
      progress:()=>()=>{},failure:()=>()=>{},options:async()=>options,browse:async()=>({folder:'',entries:[],total:0,nextOffset:null,limited:false}),
      saved:async()=>{if(++loads===1)throw new Error('Temporary saved-items read failure.');return items;},
      removeSaved:async id=>{if(failRemove){failRemove=false;throw new Error('Temporary saved-items write failure.');}items=items.filter(item=>item.id!==id);return items;}
    };
  });
  await page.reload();
  await page.getByRole('button',{name:'Saved',exact:true}).click();
  const dialog = page.getByRole('dialog',{name:'Saved items'});
  await dialog.getByText('Temporary saved-items read failure.',{exact:true}).waitFor();
  await dialog.getByRole('button',{name:'Retry saved items',exact:true}).click();
  await dialog.locator('.saved-item').filter({hasText:'First search'}).waitFor();
  await dialog.getByRole('button',{name:'Remove First search',exact:true}).click();
  await dialog.getByText('Temporary saved-items write failure.',{exact:true}).waitFor();
  await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='Remove First search');
  if(await dialog.locator('.saved-item').count()!==2)throw new Error('Failed removal discarded a saved item');
  await page.keyboard.press('Enter');
  await page.waitForFunction(()=>document.activeElement?.classList.contains('saved-item')&&document.activeElement.textContent.includes('Second search'));
  if(await dialog.locator('.saved-item').count()!==1)throw new Error('Removal did not update the list');
  await dialog.getByRole('button',{name:'Remove Second search',exact:true}).click();
  await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='Close dialog');
  await dialog.getByRole('heading',{name:'Keep a useful discovery.'}).waitFor();
  await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
  await page.waitForFunction(()=>document.activeElement?.id==='saved-button');
  return {passed:true,loadRetry:true,failedRemovalPreservedItems:true,failedRemovalFocus:true,neighborFocus:true,emptyListFocus:true,dialogFocusReturn:true};
}
