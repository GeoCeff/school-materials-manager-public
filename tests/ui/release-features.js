async (page) => {
  if (!await page.evaluate(() => window.archive?.demo)) throw new Error('Use the synthetic --demo app');
  const initial = await page.evaluate(async () => ({ status: await window.archive.status(), saved: await window.archive.saved() }));
  const waitForStatus = async predicate => {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (predicate(await page.evaluate(() => window.archive.status()))) return;
      await page.waitForTimeout(50);
    }
    throw new Error('Archive status did not reach the expected state');
  };
  const refresh = async () => {
    const previous = await page.evaluate(async () => (await window.archive.status()).job?.id);
    await page.getByRole('button', {name:'Refresh',exact:true}).click();
    await waitForStatus(({job}) => job?.id !== previous && job?.state === 'completed');
  };
  const search = page.getByRole('searchbox', {name:'Search your archive'});
  const source = page.getByRole('complementary', {name:'Selected passage'});
  async function find(query, filename) {
    await search.fill(query);
    const row = page.locator('.result-card').filter({has:page.locator('.result-title strong', {hasText:filename})});
    await row.click(); await source.locator('.source-title').filter({hasText:filename}).waitFor(); await page.waitForFunction(() => document.querySelector('.preview')?.getAttribute('aria-busy') === 'false');
    return row;
  }
  try {
    await page.setViewportSize({width:1360,height:900}); await page.context().setOffline(true);
    await refresh();
    await find('lunar', 'observatory-notes.docx');
    if (!(await source.textContent()).includes('Paragraph 2')) throw new Error('Missing Word paragraph locator');
    const feedbackBefore = await source.locator('.save-feedback').boundingBox();
    const bookmarkBefore = await source.getByRole('button', {name:'Bookmark passage'}).boundingBox();
    await source.getByRole('button', {name:'Bookmark passage'}).click(); await source.getByText('Bookmark saved.', {exact:true}).waitFor();
    const feedbackAfter = await source.locator('.save-feedback').boundingBox();
    const bookmarkAfter = await source.getByRole('button', {name:'Bookmark passage'}).boundingBox();
    if (Math.abs(feedbackBefore.height-feedbackAfter.height) > .5 || Math.abs(bookmarkBefore.width-bookmarkAfter.width) > .5) throw new Error('Bookmark feedback shifted its footprint');
    await page.getByRole('button', {name:'Save search',exact:true}).click();
    await page.getByRole('button', {name:'Saved',exact:true}).click();
    const saved = page.getByRole('dialog', {name:'Saved items'}); await saved.waitFor();
    await saved.locator('.saved-item').filter({hasText:'observatory-notes.docx'}).click();
    await source.getByRole('heading', {name:'observatory-notes.docx'}).waitFor();
    await find('lunar', 'observatory-slides.pptx');
    if (!(await source.textContent()).includes('Slide 2')) throw new Error('Missing slide locator');
    await find('conservation', 'Energy lecture.pdf');
    await source.getByRole('button', {name:'PDF page',exact:true}).click();
    const image = source.locator('.pdf-canvas img'); await image.waitFor();
    if (!(await image.getAttribute('alt')).includes('page 2')) throw new Error('PDF did not open at match');
    await source.getByRole('button', {name:'Previous PDF page'}).click();
    await page.waitForFunction(() => document.querySelector('.pdf-canvas img')?.getAttribute('alt')?.includes('page 1'));
    await source.getByRole('spinbutton', {name:'Go to PDF page'}).fill('2');
    await source.getByRole('button', {name:'Go',exact:true}).click();
    await page.waitForFunction(() => document.querySelector('.pdf-canvas img')?.getAttribute('alt')?.includes('page 2'));
    await source.getByRole('combobox', {name:'Zoom'}).selectOption('200');
    if (!await image.evaluate(el => el.complete && el.naturalWidth > 100)) throw new Error('PDF pixels did not load');
    await source.getByRole('combobox', {name:'Zoom'}).selectOption('100');
    await page.getByRole('button', {name:/^Appearance:/}).click(); await page.getByRole('menuitemradio', {name:'Light',exact:true}).click();
    await page.screenshot({animations:'disabled',path:'output/playwright/release-pdf-light.png'});
    await page.getByRole('button', {name:'Settings',exact:true}).click();
    const settings = page.getByRole('dialog', {name:'Settings'}); await settings.getByRole('checkbox', {name:'Enable offline OCR'}).check();
    await waitForStatus(status => status.ocr);
    await page.keyboard.press('Escape'); await refresh();
    await find('2042', 'observatory-scan.pdf');
    if (!(await source.textContent()).includes('Offline OCR')) throw new Error('OCR origin is not labeled');
    await source.getByRole('button', {name:'PDF page',exact:true}).click(); await image.waitFor();
    await page.getByRole('button', {name:/^Appearance:/}).click(); await page.getByRole('menuitemradio', {name:'Dark',exact:true}).click();
    await page.screenshot({animations:'disabled',path:'output/playwright/release-ocr-dark.png'});
    await page.setViewportSize({width:560,height:520});
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Narrow window overflows');
    await page.getByRole('button', {name:'Saved',exact:true}).click();
    await saved.waitFor();
    for (let i=0;i<10;i++) { await page.keyboard.press('Tab'); if (!await saved.evaluate(el => el.contains(document.activeElement))) throw new Error('Saved dialog lost keyboard focus'); }
    await page.screenshot({animations:'disabled',path:'output/playwright/release-saved-narrow.png'});
    await page.keyboard.press('Escape'); await page.emulateMedia({reducedMotion:'reduce'});
    await page.getByRole('button', {name:'Settings',exact:true}).click(); await settings.waitFor();
    if (!await settings.evaluate(el => getComputedStyle(el).animationName === 'none')) throw new Error('Reduced-motion preference ignored');
    await page.keyboard.press('Escape');
    await page.getByRole('button', {name:'Saved',exact:true}).click();
    await saved.locator('.saved-item').filter({has:page.locator('strong', {hasText:/^lunar$/})}).click();
    if (await search.inputValue() !== 'lunar') throw new Error('Saved search not restored');
    return {passed:true,officeLocators:true,bookmarks:true,savedSearches:true,offlineOcr:true,pdfNavigationAndZoom:true,narrowWindow:true,reducedMotion:true};
  } finally {
    await page.keyboard.press('Escape');
    // Cleanup must not hide the original assertion behind an active-import error.
    await page.evaluate(async () => { const api = window.archive; if (['discovering','processing','reconciling'].includes((await api.status()).job?.state)) await api.cancel(); });
    await waitForStatus(status => !['discovering','processing','reconciling'].includes(status.job?.state));
    await page.evaluate(async initial => {
      const api = window.archive; for (const item of await api.saved()) if (!initial.saved.some(saved => saved.id === item.id)) await api.removeSaved(item.id);
      await api.ocr(initial.status.ocr); await api.theme(initial.status.theme);
    }, initial);
    await page.setViewportSize({width:1360,height:900}); await page.emulateMedia({reducedMotion:'no-preference'});
  }
}
