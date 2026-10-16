async (page) => {
  if (!await page.evaluate(() => window.archive?.demo)) throw new Error('Run this check after preview-regression.js in the synthetic --demo app');
  const search = page.getByRole('searchbox', {name:'Search your archive'});
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+k');
  if (!await search.evaluate(el => el === document.activeElement)) throw new Error('Ctrl+K did not focus search');
  await search.fill('binary');
  await page.locator('.result-list [data-file-id]').first().waitFor();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Accessibility.enable');
  const {nodes} = await cdp.send('Accessibility.getFullAXTree');
  const roles = ['button','combobox','searchbox','dialog','region','complementary'];
  const controls = nodes.filter(node => !node.ignored && roles.includes(node.role?.value));
  const unnamed = controls.filter(node => !node.name?.value?.trim());
  if (unnamed.length) throw new Error('Unnamed accessibility controls: ' + JSON.stringify(unnamed.map(node => node.role?.value)));
  const liveStatuses = nodes.filter(node => !node.ignored && node.role?.value === 'status');
  if (liveStatuses.length < 2 || liveStatuses.some(node => !node.properties?.some(property => property.name === 'live' && property.value?.value === 'polite'))) throw new Error('Missing polite result/import status');
  await page.getByRole('button', {name:'Settings',exact:true}).click();
  const dialog = page.getByRole('dialog', {name:'Settings'});
  await dialog.waitFor();
  for (let step=0;step<12;step++) {
    await page.keyboard.press(step < 6 ? 'Tab' : 'Shift+Tab');
    if (!await dialog.evaluate(el => el.contains(document.activeElement))) throw new Error('Tab escaped the settings dialog');
  }
  await page.keyboard.press('Escape');
  if (!await page.getByRole('button', {name:'Settings',exact:true}).evaluate(el => el===document.activeElement)) throw new Error('Dialog did not restore focus');
  await page.getByRole('button', {name:'Import details',exact:true}).click();
  const details = page.getByRole('dialog', {name:'Import details'});
  await details.waitFor();
  for (const key of ['Tab','Shift+Tab']) {
    await page.keyboard.press(key);
    if (!await details.evaluate(el => el.contains(document.activeElement))) throw new Error('Tab escaped the single-button details dialog');
  }
  await page.keyboard.press('Escape');
  await page.setViewportSize({width:560,height:520});
  const result = page.locator('.result-list [data-file-id]').first();
  await result.focus(); await page.keyboard.press('Enter');
  await page.getByRole('button', {name:'Back to results'}).waitFor();
  await page.waitForTimeout(100);
  if (await result.isVisible()) throw new Error('Narrow results should be hidden while reading');
  await page.keyboard.press('Escape'); await page.waitForTimeout(100);
  if (!await result.evaluate(el => el===document.activeElement)) throw new Error('Narrow Escape did not restore result focus');
  await cdp.detach();
  await page.setViewportSize({width:1360,height:900});
  return {passed:true,namedControls:controls.length,politeStatusRegions:liveStatuses.length,dialogTabTrap:true,dialogEscapeFocus:true,narrowKeyboardPreview:true,screenReaderSpeechTested:false};
}
