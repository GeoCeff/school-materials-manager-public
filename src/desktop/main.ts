import { app, BrowserWindow, dialog, ipcMain, nativeTheme, screen, shell, type IpcMainInvokeEvent } from 'electron';
import { lstat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { sourcePath } from '../core/paths.js';
import { visibleArchivePath } from '../core/discovery.js';
import { createDemo } from '../demo.js';
import type { Filters, Job, Status } from '../core/model.js';
import { restoreWindow, saveWindow } from './window-state.js';
import { DesktopCollection } from './collection.js';
import { CollectionError } from '../core/collection.js';
import type { CollectionItem, CollectionJob } from '../core/collection-model.js';
import type { ClearReview, ClearResult } from '../core/local-data.js';

const smoke = process.argv.includes('--smoke');
const demo = process.argv.includes('--demo');
const hidden = process.argv.includes('--ui-test');
const dataName = `school-materials-manager${smoke ? '-smoke' : demo ? '-demo' : ''}`;
app.setPath('userData', join(app.getPath('appData'), dataName));
app.commandLine.appendSwitch('disable-background-networking');
const uiPath = fileURLToPath(new URL('../../ui/index.html', import.meta.url));
const uiURL = pathToFileURL(uiPath).href;
let window: BrowserWindow | undefined;
let serviceWorker: Worker | undefined;
let collection: DesktopCollection | undefined;
let serviceError: Error | undefined;
let requestId = 0;
let maintaining = false;
const activeIPC = new Set<Promise<unknown>>();
let removalReview: ClearReview | undefined;
const pending = new Map<number, { method: string; clearAuthorized?: boolean; resolve: (result: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

function call<T>(method: string, ...args: unknown[]): Promise<T> {
  return new Promise((resolve, reject) => {
    if (serviceError) { reject(serviceError); return; }
    const id = ++requestId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('The archive service did not respond. Restart the app.')); }, method.startsWith('collection-') || method.startsWith('clear-') ? 120_000 : method === 'document' ? 35_000 : 15_000);
    pending.set(id, { method, resolve: result => resolve(result as T), reject, timer });
    serviceWorker!.postMessage({ id, method, args });
  });
}
function validateSender(event: IpcMainInvokeEvent): void {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== uiURL) throw new Error('Archive access is only available to the application window.');
}
function text(value: unknown, max = 500): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new Error('Invalid archive request.');
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid archive request.');
  return value as Record<string, unknown>;
}
function validatedFilters(value: unknown): Filters {
  const supplied = object(value); const filters: Filters = {};
  for (const field of ['year', 'semester', 'subject', 'type'] as const) if (supplied[field]) filters[field] = text(supplied[field], 200);
  return filters;
}
function handle(channel: string, action: (...args: unknown[]) => unknown): void {
  ipcMain.handle(`archive:${channel}`, async (event, ...args) => {
    validateSender(event);
    if (maintaining) throw new Error('Finish the local data review or removal first.');
    const operation = Promise.resolve().then(() => action(...args)); activeIPC.add(operation);
    try { return await operation; } finally { activeIPC.delete(operation); }
  });
}

async function runSmoke(): Promise<void> {
  const worker = new Worker(new URL('./worker.js', import.meta.url), { workerData: app.getPath('userData') });
  const timeout = setTimeout(() => { void worker.terminate(); app.exit(1); }, 120_000);
  let reported = false;
  worker.on('message', async (report: { passed: boolean }) => {
    reported = true;
    try {
      const json = JSON.stringify(report, null, 2);
      const index = process.argv.indexOf('--report');
      if (index >= 0 && process.argv[index + 1]) await writeFile(process.argv[index + 1]!, json + '\n');
      console.log(json); clearTimeout(timeout); await worker.terminate(); app.exit(report.passed ? 0 : 1);
    } catch { void worker.terminate(); clearTimeout(timeout); app.exit(1); }
  });
  worker.on('error', error => { console.error(error.message); clearTimeout(timeout); app.exit(1); });
  worker.on('exit', () => { if (!reported) { clearTimeout(timeout); app.exit(1); } });
}

async function createWindow(): Promise<void> {
  const demoRoot = join(app.getPath('appData'), 'school-materials-manager-demo-archive');
  if (demo) await createDemo(demoRoot);
  serviceWorker = new Worker(new URL('./service-worker.js', import.meta.url), { workerData: join(app.getPath('userData'), 'data') });
  collection = new DesktopCollection(join(app.getPath('userData'), 'data'), () => window, call, () => window?.webContents.send('archive:collection-progress'), demo,join(app.getAppPath(),'dist','assets','desktop-oauth.json'));
  serviceWorker.on('message', (message: { id?: number; result?: unknown; error?: string; event?: string; job?: Job; item?: CollectionItem; collectionJob?: CollectionJob }) => {
    if (message.event === 'clear-authorized') {
      const request = pending.get(message.id!);
      if (!maintaining || request?.method !== 'clear-execute' || request.clearAuthorized) {
        serviceWorker?.postMessage({ clearAuthorized: message.id, error: 'The local data removal was not authorized.' }); return;
      }
      request.clearAuthorized = true;
      void collection!.forgetCollectionContext().then(
        () => serviceWorker?.postMessage({ clearAuthorized: message.id }),
        error => serviceWorker?.postMessage({ clearAuthorized: message.id, error: error instanceof Error ? error.message : 'Schedule removal failed. No local data was removed.' }));
      return;
    }
    if (message.event === 'collection-progress') { window?.webContents.send('archive:collection-progress'); if (message.collectionJob) void collection?.finished(message.collectionJob).catch(() => {}); return; }
    if (message.event === 'collection-abort-download') { collection?.abortDownload(message.id!); return; }
    if (message.event === 'collection-download') {
      void collection!.download(message.id!, message.item!).then(path => serviceWorker?.postMessage({ collectionDownload: message.id, path }), error => serviceWorker?.postMessage({ collectionDownload: message.id, error: error instanceof Error ? error.message : 'Download failed.',failure:error instanceof CollectionError?error.kind:'permanent' })); return;
    }
    if (message.event === 'progress') { window?.webContents.send('archive:progress', message.job);window?.webContents.send('archive:collection-progress'); return; }
    const response = pending.get(message.id!);
    if (!response) return;
    clearTimeout(response.timer); pending.delete(message.id!);
    if (message.error) response.reject(new Error(message.error)); else response.resolve(message.result);
  });
  const serviceStopped = () => {
    if (quitting || serviceError) return;
    serviceError = new Error('The archive service stopped. Restart the app; committed data is preserved.');
    for (const response of pending.values()) { clearTimeout(response.timer); response.reject(serviceError); }
    pending.clear(); window?.webContents.send('archive:service-error');
  };
  serviceWorker.on('error', serviceStopped);
  serviceWorker.on('exit', serviceStopped);
  const statePath = join(app.getPath('userData'), 'window.json');
  const bounds = restoreWindow(statePath, [screen.getPrimaryDisplay().workArea, ...screen.getAllDisplays().filter(display => display.id !== screen.getPrimaryDisplay().id).map(display => display.workArea)]);
  const initialTheme = (await call<Status>('status')).theme;
  // Keep the media query OS-owned, even in explicit modes, so System describes Windows accurately.
  nativeTheme.themeSource = 'system';
  let appearancePreference = initialTheme;
  const background = () => appearancePreference === 'dark' || (appearancePreference === 'system' && nativeTheme.shouldUseDarkColors) ? '#101012' : '#ffffff';
  window = new BrowserWindow({ ...bounds, minWidth: 560, minHeight: 520, show: false, title: 'Archive Search',
    ...(app.isPackaged ? { icon: fileURLToPath(new URL('../../assets/icon.ico', import.meta.url)) } : {}),
    backgroundColor: background(), autoHideMenuBar: true,
    webPreferences: { preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)), contextIsolation: true, sandbox: true,
      nodeIntegration: false, nodeIntegrationInWorker: false, backgroundThrottling: !hidden, offscreen: hidden, additionalArguments: [`--appearance=${initialTheme}`, ...(demo ? ['--synthetic-demo'] : [])] } });
  nativeTheme.on('updated', () => window?.setBackgroundColor(background()));
  if (bounds.maximized && !hidden) window.maximize();
  window.once('ready-to-show', () => { if (!hidden) window?.show(); });
  window.on('close', () => { if (!hidden && window) saveWindow(statePath, window.getNormalBounds(), window.isMaximized()); });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  // Archive text needs no Chromium device, notification, geolocation or clipboard permissions.
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.session.setDevicePermissionHandler(() => false);
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('data:') && !details.url.startsWith('devtools:') }));
  handle('status', () => call('status'));
  handle('clear-review', async choices => { removalReview = undefined; return collection!.maintenance(async () => removalReview = await call<ClearReview>('clear-review', choices)); });
  handle('clear-cancel', () => { removalReview = undefined; return call('clear-cancel'); });
  handle('clear-execute', async input => {
    const value = object(input); const id = text(value.id, 36);
    if (!Array.isArray(value.copies) || value.copies.length > 10000 || value.copies.some(path => typeof path !== 'string' || path.length > 32768)) throw new Error('Invalid copy selection.');
    const copies = value.copies as string[];
    const reviewed = removalReview;
    if (!reviewed || reviewed.id !== id || new Set(value.copies).size !== value.copies.length || value.copies.some(path => !reviewed.copies.some(copy => copy.path === path))) throw new Error('Review the removal scope again.');
    // Other renderer operations cannot change scope while the native confirmation is open.
    if (activeIPC.size > 1) throw new Error('Wait for the current application operation to finish, then confirm again.');
    maintaining = true;
    try {
      return await collection!.maintenance(async () => {
        const answer = await dialog.showMessageBox(window!, { type: 'warning', title: 'Permanently remove selected local data?',
          message: 'Remove the exact local data and copies in your reviewed selection?',
          detail: `${reviewed.appFiles.length} application files and ${copies.length} individually selected managed copies. Archive: ${reviewed.root ?? 'None'}.\nScopes: ${Object.entries(reviewed.choices).filter(([,selected]) => selected).map(([name]) => name).join(', ')}.\nThis cannot be undone. Original files and unselected, edited or untracked copies are kept. Connected accounts remain connected; use Disconnect separately. SSDs, backups and sync services may retain data.`,
          buttons: ['Cancel', 'Remove selected data'], defaultId: 0, cancelId: 0, noLink: true });
        if (answer.response !== 1) { await call('clear-cancel'); return null; }
        const result = await call<ClearResult>('clear-execute', id, copies);
        window?.webContents.send('archive:collection-changed');
        return result;
      });
    } finally { maintaining = false; removalReview = undefined; }
  });
  handle('choose', async () => {
    await collection?.assertNotRunning();
    const selection = demo ? demoRoot : (await dialog.showOpenDialog(window!, { title: 'Choose archive folder', properties: ['openDirectory'] })).filePaths[0];
    return selection ? call('prepare', selection) : null;
  });
  handle('start', async kind => { if (!['import', 'refresh', 'rebuild'].includes(text(kind))) throw new Error('Invalid import action.'); if (kind === 'import') await collection?.assertNotRunning(); return call('start', kind); });
  handle('cancel', () => call('cancel'));
  handle('search', request => {
    const input = object(request); const filters = validatedFilters(input.filters);
    if (!Number.isInteger(input.offset) || Number(input.offset) < 0 || Number(input.offset) > 1_000_000) throw new Error('Invalid result page.');
    return call('search', text(input.query), filters, input.offset);
  });
  handle('options', filters => call('options', validatedFilters(filters)));
  handle('browse', request => {
    const input = object(request);
    if (!Number.isSafeInteger(input.offset) || Number(input.offset) < 0 || Number(input.offset) > 1_000_000 || !['indexed', 'all'].includes(text(input.inventory))) throw new Error('Invalid file page.');
    return call('browse', { folder: text(input.folder, 32768), filters: validatedFilters(input.filters), offset: input.offset, inventory: input.inventory });
  });
  handle('preview', request => {
    const input = object(request);
    if (!Number.isSafeInteger(input.passageId) || Number(input.passageId) < 1) throw new Error('Invalid passage.');
    return call('preview', text(input.fileId, 32768), input.passageId);
  });
  handle('matches', request => { const input = object(request); return call('matches', text(input.fileId, 32768), text(input.query)); });
  async function validatedAction(id: unknown): Promise<string> {
    const path = await call<string>('resolve', text(id, 32768));
    const status = await call<Status>('status');
    if (!status.root) throw new Error('Choose an archive folder first.');
    return sourcePath(status.root, relative(status.root, path));
  }
  handle('open', async id => {
    const path = await validatedAction(id);
    if (!['.pdf', '.txt', '.md'].includes(extname(path).toLowerCase())) throw new Error('Use Show in folder for code and scripts.');
    const error = await shell.openPath(path);
    if (error) throw new Error('Windows could not open this document. Use Show in folder or check its default application.');
  });
  handle('reveal', async id => {
    // Opening the containing folder reports failures; showItemInFolder returned silently without opening Explorer in the Windows smoke check.
    const error = await shell.openPath(dirname(await validatedAction(id)));
    if (error) throw new Error('Windows could not open the containing folder. Check that it is accessible.');
  });
  handle('reveal-entry', async request => {
    const input = object(request); const root = text(input.root, 32768); const path = text(input.relativePath, 32768);
    await call('resolve-entry', root, path);
    const target = await visibleArchivePath(root, path);
    const status = await call<Status>('status');
    if (status.root !== root) throw new Error('The archive changed. Browse again.');
    const info = await lstat(target);
    const error = await shell.openPath(info.isDirectory() ? target : dirname(target));
    if (error) throw new Error('Windows could not open this folder. Check that it is accessible.');
  });
  handle('theme', value => { if (!['system','light','dark'].includes(text(value))) throw new Error('Invalid theme.'); return call('theme', value); });
  handle('appearance', value => {
    if (!['system','light','dark'].includes(text(value))) throw new Error('Invalid theme.');
    appearancePreference = value as 'system' | 'light' | 'dark';
    window?.setBackgroundColor(background());
  });
  handle('ocr', value => { if (typeof value !== 'boolean') throw new Error('Invalid OCR preference.'); return call('ocr', value); });
  handle('document', request => {
    const input = object(request);
    if (!Number.isSafeInteger(input.page) || Number(input.page) < 1 || Number(input.page) > 1000) throw new Error('Invalid PDF page.');
    return call('document', text(input.fileId, 32768), input.page);
  });
  handle('cancel-document', () => call('cancel-document'));
  handle('saved', () => call('saved'));
  handle('save-search', request => { const input = object(request); return call('save-search', text(input.query), validatedFilters(input.filters)); });
  handle('save-bookmark', request => {
    const input = object(request);
    if (!Number.isSafeInteger(input.passageId) || Number(input.passageId) < 1) throw new Error('Invalid passage.');
    return call('save-bookmark', text(input.fileId, 32768), input.passageId);
  });
  handle('remove-saved', id => call('remove-saved', text(id, 36)));
  handle('open-bookmark', id => call('open-bookmark', text(id, 36)));
  handle('collection-status', () => collection!.status());
  handle('collection-google-configure', () => collection!.configureGoogle());
  handle('collection-google-connect', options => collection!.connectGoogle(options));
  handle('collection-uvec-connect', () => collection!.connectUvec());
  handle('collection-cancel-auth', () => collection!.cancelAuth());
  handle('collection-disconnect', source => collection!.disconnect(source));
  handle('collection-courses', source => collection!.courses(source));
  handle('collection-scan', selection => collection!.scan(selection));
  handle('collection-files', options => collection!.chooseFiles(options));
  handle('collection-start', ids => collection!.start(ids));
  handle('collection-stop', action => collection!.stop(action));
  handle('collection-resume', () => collection!.resume());
  handle('collection-retry', () => collection!.retryFailed());
  handle('collection-organize', mappings => collection!.organize(mappings));
  handle('collection-preflight', ids => collection!.preflight(ids));
  handle('collection-coverage', () => collection!.coverage());
  handle('collection-assistance', () => collection!.assistance());
  handle('collection-setup-check', source => collection!.setupCheck(source));
  handle('collection-support-preview', () => collection!.supportText());
  handle('collection-support-export', () => collection!.exportSupport());
  handle('collection-schedule', enabled => collection!.schedule(enabled));
  await window.loadFile(uiPath);
}

// Electron's ESM entry must finish before readiness, so use a callback instead of top-level await.
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (!hidden) { window?.show(); window?.focus(); } });
  app.whenReady().then(() => smoke ? runSmoke() : createWindow()).catch(error => { console.error(error.message); app.exit(1); });
}
app.on('window-all-closed', () => app.quit());
let quitting = false;
app.on('before-quit', event => {
  if (!serviceWorker || quitting) return;
  event.preventDefault(); quitting = true;
  collection?.close();
  const deadline = setTimeout(() => { void serviceWorker?.terminate(); app.exit(0); }, 2_000);
  void call('close').catch(() => {}).finally(async () => { clearTimeout(deadline); await serviceWorker?.terminate(); app.quit(); });
});
