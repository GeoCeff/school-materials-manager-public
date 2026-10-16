async (page) => {
  if (!await page.evaluate(() => window.archive?.demo)) throw new Error('Run this check in the synthetic --demo app');
  const wait = async (predicate, message) => {
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error(message);
  };
  const files = page.getByRole('region', { name: 'Archive files', includeHidden: true });
  const source = page.getByRole('complementary', { name: 'Selected passage' });
  const search = page.getByRole('searchbox', { name: 'Search your archive' });
  const results = page.getByRole('region', { name: 'Search results' });
  const searchFinished = () => wait(async () => await results.getAttribute('aria-busy') === 'false' && await results.locator('.result-card').count() === 5 && await source.getAttribute('aria-busy') === 'false', 'Search or preview did not finish');
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.context().setOffline(true);
  if (!(await page.evaluate(() => window.archive.status())).root) {
    await page.getByRole('button', { name: 'Use sample archive' }).click();
    await page.getByRole('button', { name: 'Start indexing →', exact: true }).click();
  }
  await wait(async () => !['discovering', 'processing', 'reconciling'].includes((await page.evaluate(() => window.archive.status())).job?.state), 'Index did not finish');
  await wait(async () => await files.count() === 1, 'Run this check in a build with file navigation');
  if (await search.inputValue()) await page.getByRole('button', { name: 'Clear query', exact: true }).click();
  const inventory = files.getByRole('combobox', { name: 'File inventory' });
  if (await inventory.inputValue() !== 'indexed') await inventory.selectOption('indexed');
  const clearFilters = page.getByRole('button', { name: 'Clear filters', exact: true });
  if (await clearFilters.isEnabled()) await clearFilters.click();
  const root = files.getByRole('navigation', { name: 'Archive location' }).getByRole('button').first();
  if (await root.isEnabled()) await root.click();
  for (const name of ['First Year 2025-2026', 'First Semester', 'SCI 101']) {
    await wait(async () => await files.getAttribute('aria-busy') === 'false', 'Folder stayed busy');
    await files.getByRole('button', { name: name + ' Folder ›', exact: true }).click();
  }
  await files.getByRole('button', { name: 'notes.md Markdown', exact: true }).click();
  await wait(async () => (await source.textContent()).includes('Energy is the capacity'), 'Initial preview missing');
  await search.fill('energy');
  await searchFinished();
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await wait(async () => (await source.textContent()).includes('Energy is the capacity'), 'Returning to Files lost preview');
  await page.getByRole('button', { name: 'Clear query', exact: true }).click();
  await page.waitForTimeout(250);
  await wait(async () => (await source.textContent()).includes('Energy is the capacity'), 'Clearing query while in Files lost preview');
  await search.fill('energy');
  await searchFinished();
  await page.getByRole('button', { name: 'Clear query', exact: true }).click();
  await page.waitForTimeout(250);
  await wait(async () => (await source.textContent()).includes('Energy is the capacity'), 'Clearing completed query from Results lost preview');
  await search.fill('energy');
  await page.getByRole('button', { name: 'Clear query', exact: true }).click();
  await page.waitForTimeout(250);
  await wait(async () => (await source.textContent()).includes('Energy is the capacity'), 'Clearing query from Results lost preview');
  if (!await files.isVisible() || await files.getByRole('button', { name: 'notes.md Markdown', exact: true }).getAttribute('aria-pressed') !== 'true') throw new Error('Clearing query lost Files selection');
  await search.fill('conservation');
  await results.locator('.result-card').filter({ hasText: 'Energy lecture.pdf' }).click();
  await wait(async () => await results.getAttribute('aria-busy') === 'false' && await source.getAttribute('aria-busy') === 'false' && (await source.textContent()).includes('Energy lecture.pdf'), 'PDF selection did not finish');
  await source.getByRole('button', { name: 'PDF page', exact: true }).click();
  await source.locator('.pdf-canvas img').waitFor();
  // A fresh result object for the same passage must not reset the user's PDF view.
  await search.fill('conservation ');
  await wait(async () => await results.getAttribute('aria-busy') === 'true', 'Equivalent search did not start');
  await wait(async () => await results.getAttribute('aria-busy') === 'false' && await source.getAttribute('aria-busy') === 'false', 'Equivalent search did not finish');
  if (!await source.locator('.pdf-canvas img').isVisible()) throw new Error('Equivalent search reset the selected PDF view');
  await page.getByRole('button', { name: 'Clear query', exact: true }).click();
  return { passed: true, checks: ['clear query while already browsing preserves selected passage', 'clear completed query from Results restores selected passage', 'clear query during debounce restores selected passage and file selection', 'equivalent search preserves the selected PDF view'] };
}
