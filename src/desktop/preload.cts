import type { ArchiveAPI } from './bridge.js';
import type { Job } from '../core/model.js';
const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');
const initialTheme = (process.argv.find(value => value.startsWith('--appearance='))?.slice(13) ?? 'system') as ArchiveAPI['initialTheme'];
// Apply before CSS paints, including when preload runs before the parser creates <html>.
const startupAppearance = () => {
  if (!document.documentElement) return false;
  document.documentElement.dataset.theme = initialTheme === 'system' ? matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light' : initialTheme;
  return true;
};
if (!startupAppearance()) {
  const observer = new MutationObserver(() => { if (startupAppearance()) observer.disconnect(); });
  observer.observe(document, { childList: true });
}
const api: ArchiveAPI = {
  clearReview: choices => ipcRenderer.invoke('archive:clear-review', choices),
  clearExecute: (id, copies) => ipcRenderer.invoke('archive:clear-execute', { id, copies }),
  clearCancel: () => ipcRenderer.invoke('archive:clear-cancel'),
  collection: {
    status: () => ipcRenderer.invoke('archive:collection-status'),
    configureGoogle: () => ipcRenderer.invoke('archive:collection-google-configure'),
    connectGoogle: options => ipcRenderer.invoke('archive:collection-google-connect', options),
    connectUvec: () => ipcRenderer.invoke('archive:collection-uvec-connect'),
    cancelAuth: () => ipcRenderer.invoke('archive:collection-cancel-auth'),
    disconnect: source => ipcRenderer.invoke('archive:collection-disconnect', source),
    courses: source => ipcRenderer.invoke('archive:collection-courses', source),
    scan: selection => ipcRenderer.invoke('archive:collection-scan', selection),
    chooseFiles: options => ipcRenderer.invoke('archive:collection-files', options),
    start: ids => ipcRenderer.invoke('archive:collection-start', ids),
    stop: action => ipcRenderer.invoke('archive:collection-stop', action),
    resume: () => ipcRenderer.invoke('archive:collection-resume'),
    retryFailed: () => ipcRenderer.invoke('archive:collection-retry'),
    organize: mappings => ipcRenderer.invoke('archive:collection-organize',mappings),
    preflight: ids => ipcRenderer.invoke('archive:collection-preflight',ids),
    coverage: () => ipcRenderer.invoke('archive:collection-coverage'),
    assistance: () => ipcRenderer.invoke('archive:collection-assistance'),
    setupCheck: source => ipcRenderer.invoke('archive:collection-setup-check',source),
    supportText: () => ipcRenderer.invoke('archive:collection-support-preview'),
    exportSupport: () => ipcRenderer.invoke('archive:collection-support-export'),
    schedule: enabled => ipcRenderer.invoke('archive:collection-schedule', enabled),
    progress: listener => { const handler = () => listener(); ipcRenderer.on('archive:collection-progress', handler); return () => ipcRenderer.removeListener('archive:collection-progress', handler); },
  },
  demo: process.argv.includes('--synthetic-demo'),
  initialTheme,
  status: () => ipcRenderer.invoke('archive:status'),
  choose: () => ipcRenderer.invoke('archive:choose'),
  start: kind => ipcRenderer.invoke('archive:start', kind),
  cancel: () => ipcRenderer.invoke('archive:cancel'),
  search: (query, filters, offset) => ipcRenderer.invoke('archive:search', { query, filters, offset }),
  browse: request => ipcRenderer.invoke('archive:browse', request),
  options: filters => ipcRenderer.invoke('archive:options', filters),
  preview: (fileId, passageId) => ipcRenderer.invoke('archive:preview', { fileId, passageId }),
  matches: (fileId, query) => ipcRenderer.invoke('archive:matches', { fileId, query }),
  open: fileId => ipcRenderer.invoke('archive:open', fileId),
  reveal: fileId => ipcRenderer.invoke('archive:reveal', fileId),
  revealEntry: (root, relativePath) => ipcRenderer.invoke('archive:reveal-entry', { root, relativePath }),
  theme: value => ipcRenderer.invoke('archive:theme', value),
  appearance: value => ipcRenderer.invoke('archive:appearance', value),
  ocr: enabled => ipcRenderer.invoke('archive:ocr', enabled),
  document: (fileId, page) => ipcRenderer.invoke('archive:document', { fileId, page }),
  cancelDocument: () => ipcRenderer.invoke('archive:cancel-document'),
  saved: () => ipcRenderer.invoke('archive:saved'),
  saveSearch: (query, filters) => ipcRenderer.invoke('archive:save-search', { query, filters }),
  saveBookmark: (fileId, passageId) => ipcRenderer.invoke('archive:save-bookmark', { fileId, passageId }),
  removeSaved: id => ipcRenderer.invoke('archive:remove-saved', id),
  openBookmark: id => ipcRenderer.invoke('archive:open-bookmark', id),
  progress: listener => {
    const handler = (_event: Electron.IpcRendererEvent, job: Job) => listener(job);
    ipcRenderer.on('archive:progress', handler);
    return () => ipcRenderer.removeListener('archive:progress', handler);
  },
  failure: listener => {
    const handler = () => listener();
    ipcRenderer.on('archive:service-error', handler);
    return () => ipcRenderer.removeListener('archive:service-error', handler);
  },
};
contextBridge.exposeInMainWorld('archive', api);
