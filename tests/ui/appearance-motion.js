async (page) => {
  if (!await page.evaluate(() => window.archive?.demo)) throw new Error('Use the synthetic --demo app');
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const trigger = page.getByRole('button', {name:/^Appearance:/});
  const menu = page.getByRole('menu', {name:'Appearance', exact:true});
  const waitForTheme = async value => {
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      if ((await page.evaluate(() => window.archive.status())).theme === value) return;
      await page.waitForTimeout(30);
    }
    throw new Error('Appearance preference was not persisted');
  };
  const choose = async value => {
    await trigger.click(); await page.locator(`[data-choice=${value}]`).click();
    await page.waitForFunction(value => document.querySelector('.appearance-trigger')?.textContent.includes(value[0].toUpperCase()+value.slice(1)), value);
    await waitForTheme(value);
    await page.waitForTimeout(280);
  };
  const initial = await page.evaluate(() => window.archive.status());
  const search = page.getByRole('searchbox', {name:'Search your archive'});
  try {
    await page.keyboard.press('Escape'); await page.setViewportSize({width:1360,height:900});
    await page.emulateMedia({reducedMotion:'no-preference'});
    const pairs = [];
    for (const os of ['light','dark']) {
      await page.emulateMedia({colorScheme:os});
      for (const from of ['system','light','dark']) for (const to of ['system','light','dark']) {
        await choose(from); await choose(to);
        const palette = await page.evaluate(() => document.documentElement.dataset.theme);
        check(palette === (to === 'system' ? os : to), `${os}: ${from} → ${to} resolved incorrectly`);
        await trigger.click();
        check(await page.locator(`[data-choice=${to}]`).getAttribute('aria-checked') === 'true', 'Wrong selected preference');
        check((await page.locator('[data-choice=system]').textContent()).includes(`Currently ${os}`), 'System description is stale');
        await page.keyboard.press('Escape'); pairs.push(`${os}:${from}->${to}`);
      }
      for (const preference of ['system','light','dark']) {
        await choose(preference); await trigger.click();
        const focused = await page.evaluate(() => document.activeElement.dataset.choice);
        await page.emulateMedia({colorScheme:os === 'light' ? 'dark' : 'light'});
        await page.waitForTimeout(80);
        check(await page.evaluate(() => document.activeElement.dataset.choice) === focused, 'OS change stole menu focus');
        check(await page.evaluate(() => document.documentElement.dataset.theme) === (preference === 'system' ? os === 'light' ? 'dark' : 'light' : preference), 'OS overrode explicit preference');
        await page.keyboard.press('Escape'); await page.emulateMedia({colorScheme:os});
      }
    }
    await choose('system'); await trigger.focus(); await page.keyboard.press('Enter');
    check(await page.locator('[data-choice=system]').evaluate(el => el === document.activeElement), 'Menu did not focus selected row');
    for (const [key, row] of [['ArrowDown','light'],['End','dark'],['Home','system'],['ArrowUp','dark']]) {
      await page.keyboard.press(key); check(await page.locator(`[data-choice=${row}]`).evaluate(el=>el===document.activeElement), `${key} focus failed`);
    }
    await page.keyboard.press('Escape'); check(await trigger.evaluate(el=>el===document.activeElement), 'Escape focus return failed');
    await page.keyboard.press('Space'); await page.keyboard.press('End'); await page.keyboard.press('Enter');
    await waitForTheme('dark');
    check(await trigger.evaluate(el=>el===document.activeElement), 'Enter commit did not return focus');
    await page.keyboard.press('Space'); await page.keyboard.press('Home'); await page.keyboard.press('Space');
    await waitForTheme('system');
    check(await trigger.evaluate(el=>el===document.activeElement), 'Space commit did not return focus');
    await trigger.click(); await page.keyboard.press('Tab');
    check(await page.getByRole('button',{name:'Saved',exact:true}).evaluate(el=>el===document.activeElement), 'Tab did not continue normal navigation');
    await trigger.click(); await page.keyboard.press('Shift+Tab'); check(await page.locator('#appearance-menu').evaluate(el=>!el.matches(':popover-open') && el.inert), 'Shift+Tab left menu open');
    await trigger.click(); await page.getByRole('button',{name:'Settings',exact:true}).click();
    check(await page.locator('#appearance-menu').evaluate(el=>!el.matches(':popover-open') && el.inert), 'Settings did not light-dismiss menu');
    await page.keyboard.press('Escape'); await page.waitForTimeout(170);
    await trigger.click(); await search.click(); check(await page.locator('#appearance-menu').evaluate(el=>!el.matches(':popover-open') && el.inert), 'Outside click did not dismiss');
    check(await search.evaluate(el=>el===document.activeElement), 'Outside click was swallowed');

    await search.fill('conservation'); await page.locator('.result-card').filter({hasText:'Energy lecture.pdf'}).click();
    const preview = page.locator('.preview');
    await page.waitForFunction(() => document.querySelector('.preview').getAttribute('aria-busy') === 'false');
    await page.getByRole('combobox',{name:'File type'}).selectOption('PDF');
    await page.waitForTimeout(250);
    await page.waitForFunction(() => document.querySelector('.results').getAttribute('aria-busy') === 'false' && document.querySelector('.preview').getAttribute('aria-busy') === 'false');
    await preview.getByRole('button',{name:'PDF page',exact:true}).click(); await preview.locator('.pdf-canvas img').waitFor();
    await preview.getByRole('combobox',{name:'Zoom'}).selectOption('200');
    await page.evaluate(() => {
      document.querySelector('.pdf-canvas').scrollTop = 60;
      const image = document.querySelector('.pdf-canvas img'); image.dataset.continuity = 'same-image';
      const text = document.querySelector('.source-title').firstChild; const range=document.createRange(); range.selectNodeContents(text); getSelection().removeAllRanges(); getSelection().addRange(range);
    });
    const before = await page.evaluate(() => ({query:document.querySelector('#search').value,filters:[...document.querySelectorAll('.filters select')].map(el=>el.value),selection:document.querySelector('.result-card.selected')?.dataset.fileId,scroll:document.querySelector('.pdf-canvas').scrollTop,text:getSelection().toString(),src:document.querySelector('.pdf-canvas img').src}));
    for (const preference of ['light','dark','system','dark']) await choose(preference);
    const after = await page.evaluate(() => ({query:document.querySelector('#search').value,filters:[...document.querySelectorAll('.filters select')].map(el=>el.value),selection:document.querySelector('.result-card.selected')?.dataset.fileId,scroll:document.querySelector('.pdf-canvas').scrollTop,text:getSelection().toString(),src:document.querySelector('.pdf-canvas img').src}));
    check(JSON.stringify(before) === JSON.stringify(after), 'Theme change lost query, filter, selected text, selection, pixels or PDF scroll');
    check(await preview.getByRole('combobox',{name:'Zoom'}).inputValue() === '200', 'PDF zoom reset');
    check(await preview.locator('.pdf-canvas img').getAttribute('data-continuity') === 'same-image', 'PDF image was remounted');

    for (const size of [{width:1360,height:900},{width:900,height:700},{width:560,height:520}]) {
      await page.setViewportSize(size); await trigger.click(); await page.waitForTimeout(200);
      check(await menu.evaluate(el => {const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;}), 'Popup does not fit');
      await page.screenshot({path:`output/playwright/motion-menu-${size.width}.png`}); await page.keyboard.press('Escape');
      for (const name of ['Settings','Saved','Import details']) {
        await page.getByRole('button',{name,exact:true}).click();
        await page.keyboard.press('Escape');
        // Reopen during the native exit transition: an older close event must not close the new dialog.
        await page.getByRole('button',{name,exact:true}).click(); await page.waitForTimeout(240);
        check(await page.locator('dialog').evaluate(el=>el.open), 'Rapid dialog reopen was lost');
        await page.getByRole('button',{name:'Close dialog'}).click(); await page.waitForTimeout(170);
      }
      check(!await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), 'Horizontal overflow');
    }
    await page.setViewportSize({width:1360,height:900}); await page.emulateMedia({reducedMotion:'reduce'});
    await choose('light'); await trigger.click();
    check(await menu.evaluate(el=>getComputedStyle(el).transitionDuration === '0s' && getComputedStyle(el).transform === 'none'), 'Reduced-motion menu still moves');
    await page.keyboard.press('Escape'); await page.getByRole('button',{name:'Settings',exact:true}).click();
    check(await page.locator('dialog').evaluate(el=>getComputedStyle(el).transitionDuration === '0s' && getComputedStyle(el).transform === 'none'), 'Reduced-motion dialog still moves');
    await page.keyboard.press('Escape');
    await page.emulateMedia({reducedMotion:'no-preference'}); await trigger.click(); await page.locator('[data-choice=dark]').click();
    await page.emulateMedia({reducedMotion:'reduce'}); await page.waitForTimeout(40);
    check(!await page.evaluate(() => document.getAnimations().some(animation => animation.effect?.pseudoElement?.includes('view-transition') && animation.playState === 'running')), 'Reduced motion retained theme snapshots');
    await page.emulateMedia({reducedMotion:'no-preference'});
    for (const value of ['light','dark','light','dark','system','light']) {
      await page.evaluate(value => { document.querySelector('.appearance-trigger').click(); document.querySelector(`[data-choice=${value}]`).click(); }, value);
      await page.waitForTimeout(30);
    }
    await waitForTheme('light');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    await page.waitForTimeout(300);
    check(!await page.evaluate(() => document.documentElement.hasAttribute('data-theme-changing') || document.getAnimations().some(animation => animation.playState === 'running')), 'Rapid changes retained transition residue');
    return {passed:true,pairs:pairs.length,osChangesInAllPreferences:true,keyboardAndDismissal:true,stateAndPdfRetention:true,sizes:3,rapidDialogReopen:true,rapidTransitions:true,reducedMotion:true};
  } finally {
    await page.keyboard.press('Escape'); await page.setViewportSize({width:1360,height:900});
    await page.emulateMedia({reducedMotion:'reduce',colorScheme:null}); await choose(initial.theme);
    const clear = page.locator('.filters .text-button'); if (await clear.count() && await clear.isEnabled()) await clear.evaluate(el => el.click()); await page.emulateMedia({reducedMotion:'no-preference'});
  }
}
