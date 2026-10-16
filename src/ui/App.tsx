import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ArchiveAPI } from '../desktop/bridge.js';
import type { Filters, Job, Status } from '../core/model.js';
import type { Preview, SearchPage, SearchResult } from '../core/library.js';
import { PdfPreview } from './PdfPreview.js';
import { SavedPanel } from './SavedPanel.js';
import { CollectionPanel } from './CollectionPanel.js';
import { FileBrowser, fileState, type BrowseFile } from './FileBrowser.js';
import { AppearanceMenu } from './AppearanceMenu.js';
import { useAppearance } from './useAppearance.js';
import { LocalDataPanel } from './LocalDataPanel.js';
import { PrivacyDisclosure } from './PrivacyDisclosure.js';

declare global { interface Window { archive: ArchiveAPI } }
const api = window.archive;
const active = (job?: Job | null) => !!job && ['discovering', 'processing', 'reconciling'].includes(job.state);
const filename = (path: string) => path.split(/[\\/]/).pop() ?? path;
const locator = (item: SearchResult) => item.page ? `${item.type === 'Slides' ? 'Slide' : 'PDF page'} ${item.page}` : item.startLine ? `${item.type === 'Word' ? 'Paragraph' : 'Lines'} ${item.startLine}${item.endLine !== item.startLine ? `–${item.endLine}` : ''}` : 'Filename only';
const normalized = (text: string) => text.toLocaleLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
const tokens = (query: string) => new Set((query.match(/[\p{L}\p{N}]+/gu) ?? []).map(normalized));
function Highlight({ text, query }: { text: string; query: string }): ReactNode {
  const words = tokens(query);
  return text.split(/([\p{L}\p{N}]+)/gu).map((part, index) => words.has(normalized(part)) ? <mark key={index}>{part}</mark> : part);
}
function excerpt(text: string, query: string): string {
  const words = tokens(query);
  const match = [...text.matchAll(/[\p{L}\p{N}]+/gu)].find(word => words.has(normalized(word[0])));
  const start = Math.max(0, (match?.index ?? 0) - 75);
  return (start ? '…' : '') + text.slice(start, start + 310) + (start + 310 < text.length ? '…' : '');
}
function jobText(job: Job): string {
  if (job.state === 'discovering') return 'Discovering eligible files…';
  if (job.state === 'processing') return `${job.kind === 'rebuild' ? 'Rebuilding' : 'Indexing'} ${job.processed} of ${job.total} files`;
  if (job.state === 'reconciling') return 'Checking the completed scan…';
  if (job.state === 'cancelled') return job.kind === 'rebuild' ? 'Stopped. The current library remains available.' : 'Stopped. Files already indexed remain available.';
  if (job.state === 'failed') return 'Indexing did not finish. Existing results are retained.';
  if (job.state === 'interrupted') return 'The previous import was interrupted. Refresh to continue.';
  const attention = job.counts.failed || job.errors.length;
  return attention ? `Finished with ${attention} ${attention === 1 ? 'file or folder' : 'files or folders'} needing attention` : 'Your library is up to date.';
}
const reasons: Record<string, string> = {
  'extraction-resource-limit': 'The isolated PDF parser reached its Windows memory limit. The original file is unchanged.',
  'parser-containment-unavailable': 'Windows PDF containment could not be established. Parsing was refused; restart the app or check its installation.',
  'pdf-render-limit': 'Some PDF image content was skipped because it exceeds the safe rendering limits. Its contents are unavailable to OCR; the original file is unchanged.',
  'invalid-office': 'This Office document could not be read safely.', 'office-limit': 'This Office document exceeds the extraction limits.', 'ocr-unavailable': 'Windows OCR is unavailable. Install a Windows recognition language or disable OCR and refresh.', 'ocr-timeout': 'Windows OCR took too long. Try again or disable OCR.', 'invalid-pdf': 'This PDF could not be read.', 'encrypted-pdf': 'This PDF requires a password.', 'unsupported-encoding': 'This text encoding is not supported.',
  'size-limit': 'This file exceeds the import size limit.', 'text-limit': 'This file exceeds the extracted-text limit.', 'page-limit': 'This PDF exceeds the page limit.',
  'binary-content': 'This file contains binary content.', 'extraction-timeout': 'Extraction reached its time limit (30 seconds, or 120 with OCR).', 'unreadable-directory': 'This folder could not be scanned.',
  'unavailable-root': 'The archive folder is unavailable.', 'replacement-incomplete': 'The replacement was not activated because some files or folders could not be processed.',
  'changed-during-extraction': 'This file changed during extraction. Try refreshing.', 'extraction-failed': 'This file could not be extracted.',
};

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [notice, setNotice] = useState('');
  const appearance = useAppearance(api, message => setNotice(previous => message || (previous.startsWith('Appearance could not be saved.') ? '' : previous)));
  const [candidate, setCandidate] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<Filters>({});
  const [options, setOptions] = useState<Status['options']>({ year: [], semester: [], subject: [], type: [] });
  const [page, setPage] = useState<SearchPage>({ results: [], total: 0, nextOffset: null });
  const [resultsQuery, setResultsQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [queryError, setQueryError] = useState('');
  const [selection, setSelection] = useState<SearchResult | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [moreMatches, setMoreMatches] = useState<SearchResult[]>([]);
  const [matchesLoading, setMatchesLoading] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [modal, setModal] = useState<'settings' | 'details' | 'saved' | 'collection' | null>(null);
  const [dialogVersion, setDialogVersion] = useState(0);
  const openModal = (value: 'settings' | 'details' | 'saved' | 'collection') => { setDialogVersion(version => version + 1); setModal(value); };
  const [pdfView, setPdfView] = useState(false);
  const [bookmarked, setBookmarked] = useState<Preview | null>(null);
  const [saveMessage, setSaveMessage] = useState('');
  const [savedQuery, setSavedQuery] = useState('');
  const [revision, setRevision] = useState(0);
  const [view, setView] = useState<'files' | 'results'>('files');
  const [inventory, setInventory] = useState<'indexed' | 'all'>('indexed');
  const [browseSelection, setBrowseSelection] = useState<BrowseFile | null>(null);
  const root = useRef<string | null>(null);
  const statusSequence = useRef(0);
  const resultsPane = useRef<HTMLElement>(null);
  const resultsScroll = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const dialogContent = useRef<'settings' | 'details' | 'saved' | 'collection'>('settings');
  if (modal) dialogContent.current = modal;
  const displayedModal = dialogContent.current;
  const sequence = useRef(0);
  const previewSequence = useRef(0);
  const running = active(status?.job);
  const searchable = status ? status.coverage.indexed + status.coverage.partial + status.coverage.stale : 0;
  const selectedFile = bookmarked ?? (view === 'files' ? browseSelection : selection);
  const selectedId = selectedFile?.fileId;
  const selectedPassage = selectedFile?.passageId;
  const previewQuery = view === 'results' ? resultsQuery : '';
  const filtersPaused = view === 'files' && inventory === 'all';

  const loadStatus = async () => {
    const request = ++statusSequence.current;
    const next = await api.status();
    if (request !== statusSequence.current) return;
    if (root.current !== next.root) {
      root.current = next.root; sequence.current++; previewSequence.current++;
      setBookmarked(null); setView('files'); setInventory('indexed'); setBrowseSelection(null); setSelection(null); setPreview(null); setPreviewOpen(false);
      setPage({ results: [], total: 0, nextOffset: null }); resultsScroll.current = 0;
    }
    setStatus(next);
  };
  const perform = async (action: () => Promise<unknown>) => {
    setPending(true); setNotice('');
    try { await action(); await loadStatus(); } catch (error) { setNotice(error instanceof Error ? error.message : 'The action could not be completed.'); }
    finally { setPending(false); }
  };
  useEffect(() => {
    if (!api) { setNotice('Open this application with Electron to access your local archive.'); return; }
    void loadStatus().catch(error => setNotice(error.message));
    const unsubscribe = api.progress(job => {
      setStatus(previous => previous ? { ...previous, job } : previous);
      if (!active(job) || job.processed % 5 === 0) void loadStatus().catch(error => setNotice(error.message));
      if (!active(job)) setRevision(value => value + 1);
    });
    const failure = api.failure(() => setNotice('The archive service stopped. Restart the app; committed data is preserved.'));
    return () => { unsubscribe(); failure(); };
  }, []);
  useEffect(() => {
    if (!status?.root || filtersPaused) return;
    let current = true;
    void api.options(filters).then(next => {
      if (!current) return;
      setOptions(next);
      setFilters(previous => {
        const valid = { ...previous }; let changed = false;
        for (const field of ['year','semester','subject','type'] as const) if (valid[field] && !next[field].includes(valid[field]!)) { delete valid[field]; changed = true; }
        return changed ? valid : previous;
      });
    }).catch(error => { if (current) setNotice(error.message); });
    return () => { current = false; };
  }, [filters, status?.root, status?.files, revision, filtersPaused]);
  useEffect(() => {
    if (dialog.current) dialog.current.inert = !modal;
    if (modal && dialog.current && !dialog.current.open) dialog.current.showModal();
    if (!modal && dialog.current?.open) dialog.current.close();
  }, [modal]);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key.toLowerCase() === 'k') { event.preventDefault(); if (!modal) input.current?.focus(); }
      if (event.key === 'Escape' && !event.defaultPrevented && !document.querySelector(':popover-open') && !modal && previewOpen) closePreview();
    };
    window.addEventListener('keydown', keyboard); return () => window.removeEventListener('keydown', keyboard);
  }, [modal, previewOpen, selection, view, browseSelection, bookmarked]);
  useEffect(() => {
    if (!status?.root || !api) return;
    const request = ++sequence.current;
    if (!query.trim()) { setPage({ results: [], total: 0, nextOffset: null }); setSelection(null); setSearching(false); setQueryError(''); return; }
    setSearching(true); setQueryError('');
    const timer = setTimeout(async () => {
      try {
        const result = await api.search(query, filters, 0);
        if (request !== sequence.current) return;
        setPage(result); setResultsQuery(query);
        setSelection(previous => result.results.find(row => row.fileId === previous?.fileId) ?? result.results[0] ?? null);
      } catch (error) { if (request === sequence.current) setQueryError(error instanceof Error ? error.message : 'Search failed. Try again.'); }
      finally { if (request === sequence.current) setSearching(false); }
    }, 180);
    return () => clearTimeout(timer);
  }, [query, filters, status?.root, revision]);
  useEffect(() => {
    const request = ++previewSequence.current;
    setPdfView(false); setSaveMessage('');
    setMoreMatches([]); setMatchesLoading(false); setPreviewError('');
    if (!selectedId || !selectedPassage) { setPreview(null); setPreviewLoading(false); return; }
    setPreviewLoading(true);
    void api.preview(selectedId, selectedPassage).then(result => { if (request === previewSequence.current) setPreview(result); })
      .catch(error => { if (request === previewSequence.current) { setPreview(null); setPreviewError(error.message); } })
      .finally(() => { if (request === previewSequence.current) setPreviewLoading(false); });
  }, [selectedId, selectedPassage, view, revision]);
  useEffect(() => { if (view === 'results' && resultsPane.current) resultsPane.current.scrollTop = resultsScroll.current; }, [view]);

  const choose = () => perform(async () => { const root = await api.choose(); if (root) setCandidate(root); });
  const start = (kind: Job['kind']) => perform(async () => { await api.start(kind); if (kind === 'import') setCandidate(null); });
  const select = (result: SearchResult) => {
    setBookmarked(null); setSelection(result); setPreviewOpen(true);
    requestAnimationFrame(() => {
      const back = document.querySelector<HTMLButtonElement>('.back-button');
      if (back?.getClientRects().length) back.focus();
    });
  };
  const activateFile = (file: BrowseFile) => {
    setBookmarked(null); setBrowseSelection(file); setPreviewOpen(true);
    requestAnimationFrame(() => { const back = document.querySelector<HTMLButtonElement>('.back-button'); if (back?.getClientRects().length) back.focus(); });
  };
  const changeView = (next: 'files' | 'results') => { setBookmarked(null); if (next !== view) previewSequence.current++; setView(next); setPreviewOpen(false); };
  const closePreview = () => {
    if (bookmarked) { setBookmarked(null); requestAnimationFrame(() => document.getElementById('saved-button')?.focus()); }
    setPreviewOpen(false);
    // Restore focus after the narrow results pane becomes visible again.
    requestAnimationFrame(() => document.querySelectorAll<HTMLButtonElement>(view === 'files' ? '[data-entry-path]' : '.result-list [data-file-id]').forEach(button => {
      if (view === 'files' ? button.dataset.entryPath === browseSelection?.relativePath : button.dataset.fileId === selection?.fileId) button.focus();
    }));
  };
  const loadMore = async () => {
    if (page.nextOffset === null) return;
    const request = sequence.current; setSearching(true);
    try { const next = await api.search(query, filters, page.nextOffset); if (request === sequence.current) setPage(previous => ({ ...next, results: [...previous.results, ...next.results] })); }
    catch (error) { if (request === sequence.current) setNotice((error as Error).message); } finally { if (request === sequence.current) setSearching(false); }
  };
  const loadMatches = async () => {
    if (!preview) return;
    const request = previewSequence.current; const searchRequest = sequence.current;
    const current = () => request === previewSequence.current && searchRequest === sequence.current;
    setMatchesLoading(true);
    try { const matches = await api.matches(preview.fileId, resultsQuery); if (current()) setMoreMatches(matches); }
    catch (error) { if (current()) setNotice((error as Error).message); }
    finally { if (request === previewSequence.current) setMatchesLoading(false); }
  };
  const toggleOcr = (enabled: boolean) => {
    setStatus(previous => previous ? { ...previous, ocr: enabled } : previous);
    void perform(async () => { try { await api.ocr(enabled); } catch (error) { await loadStatus(); throw error; } });
  };
  const themeControl = <AppearanceMenu {...appearance} dismiss={!!modal} onChoose={value => void appearance.choose(value)} />;

  return <div className="app-shell">
    <header className="topbar"><div className="wordmark"><span className="brand-icon" aria-hidden="true">≡</span><span>archive search</span>{api?.demo && <span className="pill">Synthetic demo</span>}</div>
      <div className="header-actions">{themeControl}{status?.root && <><button id="saved-button" onClick={() => openModal('saved')}>Saved</button>{api.collection && <button id="collection-button" onClick={() => openModal('collection')}>Collect</button>}</>}<button onClick={() => openModal('settings')}>Settings</button></div></header>
    {notice && <div className="notice" role="alert"><span>{notice}</span>{!status && api && <button onClick={() => void perform(loadStatus)}>Retry</button>}<button aria-label="Dismiss message" onClick={() => setNotice('')}>×</button></div>}
    {!status ? <main className="welcome"><p role="status">{notice ? 'The archive service needs attention.' : 'Opening your library…'}</p></main> : <>
      {status.problem && <div className="notice" role="alert">{status.problem}{status.root && !status.canRefresh && <button disabled={running || pending} onClick={() => void start('rebuild')}>Rebuild index</button>}</div>}
      {status.root && !status.available && <div className="notice" role="status">The archive folder is unavailable. Existing results may be out of date.<button disabled={running || pending} onClick={() => void choose()}>Choose folder</button></div>}
      {candidate && <section className="candidate" aria-label="Selected archive"><div><span className="eyebrow">Selected folder</span><p className="path">{candidate}</p>{status.root && <p>This folder will replace the searched library after its import completes. Your originals stay intact.</p>}</div>
        <div className="button-row"><button disabled={pending || running} onClick={() => void choose()}>Choose another</button><button className="primary" disabled={pending || running} onClick={() => void start('import')}>Start indexing →</button><button disabled={pending} onClick={() => setCandidate(null)}>Cancel</button></div></section>}
      {!status.root ? <main className="welcome"><section className="welcome-card"><div className="halftone" aria-hidden="true" /><span className="eyebrow">Your files. A little easier to find.</span>
        <h1>Remember the idea.<br />Find the page.</h1><p className="lead">Search PDFs, Word, slides, notes, and code.<br />Your files stay on this computer.</p>
        <button className="primary choose-button" disabled={pending || !!candidate} onClick={() => void choose()}>{api.demo ? 'Use sample archive' : 'Choose archive folder'} <span aria-hidden="true">↗</span></button>
        <div className="welcome-formats"><span>01 — CHOOSE A FOLDER</span><span>02 — INDEX ITS CONTENTS</span><span>03 — FIND A PASSAGE</span></div>
        <p className="small-copy">PDF · Word · PowerPoint · Notes · Code<br />Optional offline OCR for scanned PDFs. The separate search index is local and unencrypted.</p></section></main> : <>
        <section className="search-bar" aria-label="Archive search"><form onSubmit={event => { event.preventDefault(); setRevision(value => value + 1); }}><label htmlFor="search">Search your archive</label>
          <div className="search-input"><span aria-hidden="true">⌕</span><input ref={input} id="search" type="search" maxLength={500} value={query} onChange={event => { sequence.current++; setQuery(event.target.value); changeView(event.target.value.trim() ? 'results' : 'files'); }} placeholder='Try a concept, filename, or "exact phrase"' autoComplete="off" spellCheck="false" />
            {query ? <button type="button" onClick={() => { sequence.current++; setQuery(''); changeView('files'); input.current?.focus(); }}>Clear query</button> : <kbd>Ctrl K</kbd>}</div></form>
          <div className="search-meta"><span>{filename(status.root)} <span className="muted">/ {searchable} searchable files</span></span><div className="view-controls" aria-label="Workspace view">{query.trim() && <button className="save-search" aria-label="Save search" disabled={pending || searching || !!queryError} onClick={() => void perform(async () => { await api.saveSearch(query, filters); setSavedQuery(JSON.stringify([status.root, query, filters])); })}>{savedQuery === JSON.stringify([status.root, query, filters]) ? 'Saved ✓' : 'Save search'}</button>}<button aria-pressed={view === 'files'} onClick={() => changeView('files')}>Files</button>{query.trim() && <button aria-pressed={view === 'results'} onClick={() => changeView('results')}>Results</button>}<button className="filter-toggle" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(value => !value)}>Filters {Object.values(filters).filter(Boolean).length || ''}</button></div></div><span className="sr-only" role="status">{savedQuery === JSON.stringify([status.root, query, filters]) ? 'Search saved. Open Saved to return to it.' : ''}</span></section>
        <main className={`workspace ${previewOpen ? 'preview-open' : ''}`}><aside className={`filters ${filtersOpen ? 'expanded' : ''}`} aria-label="Search filters"><span className="eyebrow">01 — Archive</span><h2>Narrow your search</h2>
          {filtersPaused && <p className="small-copy">Filters paused. They apply to indexed files and search.</p>}
          {(['year','semester','subject','type'] as const).map(field => <label key={field}>{field === 'type' ? 'File type' : field[0]!.toUpperCase() + field.slice(1)}<select disabled={filtersPaused} value={filters[field] ?? ''} onChange={event => setFilters(previous => ({ ...previous, [field]: event.target.value || undefined }))}>
            <option value="">All {field === 'type' ? 'file types' : `${field}s`}</option>{options[field].map(value => <option key={value} value={value}>{value === '__other__' ? 'Other' : value}</option>)}</select></label>)}
          <button className="text-button" disabled={filtersPaused || !Object.values(filters).some(Boolean)} onClick={() => setFilters({})}>Clear filters</button><div className="filter-note"><p>Words match together.<br />Quotes find a phrase.</p><p>Enable offline OCR in Settings for scanned PDFs.</p></div></aside>
          <FileBrowser key={status.root} api={api} root={status.root} filters={filters} revision={`${revision}:${status.files}`} active={view === 'files'} selection={browseSelection} onSelection={setBrowseSelection} onActivate={activateFile} onInventory={setInventory} onClearFilters={() => setFilters({})} />
          <section ref={resultsPane} hidden={view !== 'results'} className="results" aria-label="Search results" aria-busy={searching} onScroll={event => { if (view === 'results') resultsScroll.current = event.currentTarget.scrollTop; }}><div className="pane-heading"><span className="eyebrow">02 — Results</span><span className="muted" role="status">{searching ? 'Searching…' : query.trim() ? `${page.total} ${page.total === 1 ? 'file' : 'files'}` : 'Ready when you are'}</span></div>
            {queryError && <div className="notice" role="alert">{queryError}</div>}{searching && page.results.length > 0 && <p className="small-copy">Updating results. Showing matches for “{resultsQuery}”.</p>}
            {!query.trim() ? <div className="empty-state"><span className="empty-glyph" aria-hidden="true">⌕</span><h2>What are you looking for?</h2><p>Start with a concept, a few words you remember, or a filename.</p>{status.files === 0 && !running && <p>No supported files are indexed. Choose a folder containing text PDFs, notes, or code.</p>}</div> : !searching && !queryError && page.results.length === 0 ? <div className="empty-state"><h2>No matches found.</h2><p>Try fewer words or clear a filter.</p><p className="small-copy">Phrases stay inside one page passage or line group. Words use exact tokens without stemming.</p></div> : <div className="result-list" onKeyDown={event => {
              if (!['ArrowDown','ArrowUp','Home','End'].includes(event.key)) return;
              const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-file-id]')];
              const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.min(buttons.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)));
              event.preventDefault(); buttons[next]?.focus();
            }}>{page.results.map(result => <button className={`result-card ${selection?.fileId === result.fileId ? 'selected' : ''}`} key={result.fileId} data-file-id={result.fileId} aria-pressed={selection?.fileId === result.fileId} onClick={() => select(result)}>
              <div className="result-title"><strong><Highlight text={filename(result.relativePath)} query={resultsQuery} /></strong><span className="pill">{result.type}</span></div><div className="result-context">{result.subject ?? 'Other'} · {result.filenameOnly ? 'Filename match' : locator(result)}{result.status === 'stale' && ' · Previous indexed text'}</div>
              <p>{result.filenameOnly ? result.text ? 'This query matched the filename.' : 'No searchable text. Select for details.' : <Highlight text={excerpt(result.text, resultsQuery)} query={resultsQuery} />}</p><span className="result-path">{result.relativePath}</span>{result.matchCount > 1 && <span className="match-count">{result.matchCount} matching passages</span>}</button>)}</div>}
            {page.nextOffset !== null && <button className="load-more" disabled={searching} onClick={() => void loadMore()}>Load more results</button>}</section>
          <aside className="preview" aria-label="Selected passage" aria-busy={previewLoading}><div className="pane-heading"><span className="eyebrow">03 — Source</span><button className="back-button" onClick={closePreview}>← Back to {view}</button></div>
            {previewLoading ? <p role="status">Loading passage…</p> : previewError ? <div className="notice" role="alert">{previewError}<button onClick={() => setRevision(value => value + 1)}>Search again</button></div> : preview ? <>
              <h2 className="source-title">{filename(preview.relativePath)}</h2><p className="result-context">{preview.subject ?? 'Other'} · {locator(preview)}</p><p className="source-path">{preview.relativePath}</p>
              {(preview.status === 'stale' || preview.availability === 'changed') && <div className="notice">Previous indexed text. This file changed or failed its latest extraction. Refresh to update it.</div>}
              {['missing','unsafe'].includes(preview.availability) && <div className="notice">The source is unavailable or outside the archive boundary. Stored text is still visible.</div>}
              {(preview.status === 'no-text' || preview.status === 'partial') && <div className="notice">{preview.status === 'partial' ? 'Some PDF content is unavailable to text extraction or OCR. Check any extraction warning below.' : preview.type === 'PDF' ? 'This PDF has no extractable text. OCR may be needed to search its contents.' : 'This file contains no searchable text.'}</div>}
              {preview.error && <div className="notice">{reasons[preview.error] ?? 'The latest extraction needs attention.'}</div>}
              <div className="button-row source-actions"><button className="bookmark-button" aria-label="Bookmark passage" disabled={pending} onClick={() => void perform(async () => { const request = previewSequence.current; await api.saveBookmark(preview.fileId, preview.passageId); if (request === previewSequence.current) setSaveMessage('Bookmark saved.'); })}>{saveMessage ? 'Bookmarked ✓' : 'Bookmark passage'}</button>{preview.canOpen && <button className="primary" onClick={() => void perform(() => api.open(preview.fileId))}>Open document ↗</button>}<button disabled={['missing','unsafe'].includes(preview.availability) || pending} onClick={() => void perform(() => api.reveal(preview.fileId))}>Show in folder</button></div>
              <p className="small-copy save-feedback" role="status">{saveMessage && <span>{saveMessage}</span>}</p>{preview.type === 'PDF' && <div className="view-controls preview-tabs" aria-label="Preview format"><button aria-pressed={!pdfView} onClick={() => setPdfView(false)}>Text</button><button disabled={['missing','unsafe'].includes(preview.availability)} aria-pressed={pdfView} onClick={() => setPdfView(true)}>PDF page</button></div>}{pdfView && preview.type === 'PDF' ? <PdfPreview key={`${preview.fileId}:${preview.passageId}`} api={api} fileId={preview.fileId} initialPage={preview.page ?? 1} /> : <><span className="eyebrow">{preview.text ? preview.origin?.startsWith('ocr:') ? `Offline OCR · ${preview.origin.slice(4)} · Check against original` : 'Extracted text' : 'Filename only'}</span>{preview.text ? <pre className={preview.type === 'Code' ? 'passage code' : 'passage'}>{preview.type === 'Code' ? preview.text.split('\n').map((line, index) => <span className="code-line" key={index}><span className="line-number" aria-hidden="true">{(preview.startLine ?? 1) + index}</span><span><Highlight text={line} query={previewQuery} />{'\n'}</span></span>) : <Highlight text={preview.text} query={previewQuery} />}</pre> : <p>No passage is available. Refresh after replacing this file with a readable document.</p>}</>}
              {!bookmarked && view === 'results' && selection && selection.matchCount > 1 && <><button className="text-button" disabled={matchesLoading || searching} onClick={() => void loadMatches()}>{matchesLoading ? 'Loading matches…' : 'More matches in this file'}</button>{moreMatches.length > 0 && <div className="passage-list">{moreMatches.map(match => <button key={match.passageId} onClick={() => setSelection(match)}>{locator(match)}<span>{excerpt(match.text, resultsQuery).slice(0, 90)}</span></button>)}</div>}</>}
            </> : view === 'files' && browseSelection && !browseSelection.fileId ? <><h2 className="source-title">{browseSelection.name}</h2><p className="source-path">{browseSelection.relativePath}</p><p className="result-context">{browseSelection.type}{browseSelection.size !== null && ` · ${Number(browseSelection.size).toLocaleString()} bytes`}</p><div className="notice">{fileState(browseSelection.status)}. {browseSelection.status === 'unsupported' ? 'This format has no text preview or search support in this version.' : 'Refresh to add this eligible file to the search index.'}</div><div className="button-row source-actions"><button disabled={pending} onClick={() => void perform(() => api.revealEntry(status.root!, browseSelection.relativePath))}>Show in folder</button></div></> : <div className="empty-state"><h2>A little context.</h2><p>Select a {view === 'files' ? 'file to inspect its stored text' : 'result to read its passage'} and locate the original.</p></div>}</aside></main>
        <footer className="statusbar"><div><span className="status-dot" aria-hidden="true" /><span role="status">{status.job ? jobText(status.job) : 'Choose a folder and start indexing.'}</span>{running && status.job?.total !== null && <progress max={status.job?.total || 1} value={status.job?.processed ?? 0} aria-label="Files processed" />}</div>
          <div className="button-row"><button onClick={() => openModal('details')}>Import details</button>{running ? <button disabled={pending} onClick={() => void perform(() => api.cancel())}>Stop indexing</button> : <button disabled={pending || !status.canRefresh} onClick={() => void start('refresh')}>Refresh</button>}</div></footer>
      </>}
      <dialog ref={dialog} className="modal" aria-labelledby="dialog-title" onCancel={event => { event.preventDefault(); setModal(null); }} onClose={event => { if (!event.currentTarget.open) setModal(null); }} onKeyDown={event => {
        if (event.key !== 'Tab') return;
        const buttons = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]')];
        const edge = event.shiftKey ? buttons[0] : buttons.at(-1);
        if (document.activeElement === edge) {
          // Native dialog traversal can blur Electron's web contents at either end.
          event.preventDefault(); (event.shiftKey ? buttons.at(-1) : buttons[0])?.focus();
        }
      }}><div className="pane-heading"><h2 id="dialog-title">{displayedModal === 'collection' ? 'Collect school materials' : displayedModal === 'details' ? 'Import details' : displayedModal === 'saved' ? 'Saved items' : 'Settings'}</h2><button aria-label="Close dialog" onClick={() => setModal(null)}>×</button></div>
        {displayedModal === 'collection' ? <CollectionPanel key={dialogVersion} api={api.collection} active={modal === 'collection'} onRefresh={() => { setModal(null); void start('refresh'); }} /> : displayedModal === 'saved' ? <SavedPanel key={dialogVersion} api={api} active={modal === 'saved'} onSearch={item => { setModal(null); setBookmarked(null); setFilters(item.filters); setQuery(item.query); changeView('results'); setRevision(value => value + 1); requestAnimationFrame(() => input.current?.focus()); }} onBookmark={item => { setModal(null); setBookmarked(item); setPreviewOpen(true); requestAnimationFrame(() => { const back = document.querySelector<HTMLButtonElement>('.back-button'); if (back?.getClientRects().length) back.focus(); }); }} /> : displayedModal === 'settings' ? <><span className="eyebrow">Current archive</span><p className="path">{status.root ?? 'No archive selected'}</p><p>{status.lastScan ? `Last successful scan: ${new Date(status.lastScan).toLocaleString()}` : 'No fully successful scan has completed.'}</p><div className="button-row"><button disabled={running || pending} onClick={() => void perform(async () => { const root = await api.choose(); if (root) { setCandidate(root); setModal(null); } })}>Change folder</button><button disabled={running || pending} onClick={() => void start('rebuild')}>Rebuild index</button></div><p className="small-copy">Rebuild creates a replacement index. The current library stays active until a complete replacement succeeds.</p><hr /><h3>Read scanned PDFs</h3><label className="check-control"><input type="checkbox" checked={status.ocr} disabled={running || pending} onChange={event => toggleOcr(event.target.checked)} /> Enable offline OCR</label><p className="small-copy">Uses installed Windows recognition languages. After changing this setting, Refresh to reprocess PDFs. Image-only pages can take longer; recognition may contain mistakes.</p><hr /><PrivacyDisclosure /><hr /><LocalDataPanel api={api} onComplete={async () => { await loadStatus(); setSelection(null); setBookmarked(null); setPreview(null); setRevision(value => value + 1); }} /><hr /><h3>Local by design.</h3><p className="small-copy">Archive Search 0.3.0 · Windows desktop<br />No telemetry or content uploads. Optional collection contacts only the connected provider. The separate index contains extracted content and is not encrypted.</p><p className="small-copy">PDFs: 32 MiB / 1,000 pages. Word and slides: 32 MiB, text only. Text/code: 2 MiB. Extraction: 30 seconds, or 120 seconds with OCR (first 20 image-only pages per PDF).</p></> : <>
          <p role="status">{status.job ? jobText(status.job) : 'No import has run yet.'}</p><div className="coverage-grid"><span><strong>{searchable}</strong>Searchable files</span><span><strong>{status.coverage.noText + status.coverage.failed}</strong>Filename only</span><span><strong>{status.coverage.partial + status.coverage.stale}</strong>Partial or stale</span><span><strong>{status.files}</strong>Files in index</span></div>
          {status.job && <><dl className="job-counts">{Object.entries(status.job.counts).map(([key,value]) => <div key={key}><dt>{key === 'noText' ? 'No text' : key[0]!.toUpperCase() + key.slice(1)}</dt><dd>{value}</dd></div>)}</dl><p className="small-copy">{status.job.processed} completed attempts of {status.job.total ?? 'an unknown number of'} eligible files. Skipped includes unsupported entries and excluded directories.{status.job.pruningSkipped && ' Missing files were not removed from the active index.'}</p>
            {status.job.errors.length > 0 && <div className="error-list">{status.job.errors.map((error,index) => <article key={index}><strong>{error.path}</strong><p>{reasons[error.category] ?? 'This entry could not be processed. Try refreshing.'}</p></article>)}<p className="small-copy">Details are limited to the first 200 entries.</p></div>}</>}
        </>}</dialog>
    </>}
  </div>;
}
