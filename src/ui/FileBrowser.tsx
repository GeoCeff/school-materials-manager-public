import { useEffect, useRef, useState } from 'react';
import type { ArchiveAPI } from '../desktop/bridge.js';
import type { BrowseEntry, BrowsePage, BrowseRequest, Filters } from '../core/model.js';

export const fileState = (status: string) => ({ 'no-text': 'No text', partial: 'Partial', failed: 'Failed', stale: 'Previous indexed text', 'not-indexed': 'Not indexed', unsupported: 'Not searchable in this version' }[status] ?? 'Indexed');
export type BrowseFile = Extract<BrowseEntry, { kind: 'file' }>;

export function FileBrowser({ api, root, filters, revision, active, selection, onSelection, onActivate, onInventory, onClearFilters }: {
  api: ArchiveAPI; root: string; filters: Filters; revision: string; active: boolean; selection: BrowseFile | null;
  onSelection: (file: BrowseFile | null) => void; onActivate: (file: BrowseFile) => void;
  onInventory: (inventory: BrowseRequest['inventory']) => void; onClearFilters: () => void;
}) {
  const [folder, setFolder] = useState('');
  const [inventory, setInventory] = useState<BrowseRequest['inventory']>('indexed');
  const [page, setPage] = useState<BrowsePage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const [retry, setRetry] = useState(0);
  const sequence = useRef(0);
  const pane = useRef<HTMLElement>(null);
  const scroll = useRef(0);
  const focusAfterNavigation = useRef(false);
  const displayed = useRef(50);
  const selected = useRef(selection); selected.current = selection;
  const select = useRef(onSelection); select.current = onSelection;
  const request = (offset: number) => api.browse({ folder, filters, inventory, offset });

  useEffect(() => {
    const id = ++sequence.current;
    setLoading(true); setError('');
    void (async () => {
      let next = await request(0);
      while (id === sequence.current && next.nextOffset !== null && next.entries.length < displayed.current) {
        const more = await request(next.nextOffset);
        next = { ...more, entries: [...next.entries, ...more.entries] };
      }
      return next;
    })().then(next => {
      if (id !== sequence.current) return;
      setPage(next);
      if (next.folder !== folder) { setFolder(next.folder); setAnnouncement('That folder was removed from the index. Returned to its nearest remaining ancestor.'); }
      if (selected.current) select.current(next.entries.find((entry): entry is BrowseFile => entry.kind === 'file' && entry.relativePath === selected.current!.relativePath) ?? null);
      if (focusAfterNavigation.current) {
        focusAfterNavigation.current = false;
        requestAnimationFrame(() => pane.current?.querySelector<HTMLButtonElement>('[data-entry-path]:not(:disabled),.browse-location button:not(:disabled)')?.focus());
      }
    }).catch(reason => { if (id === sequence.current) setError(reason.message); })
      .finally(() => { if (id === sequence.current) setLoading(false); });
    return () => { sequence.current++; };
  }, [folder, inventory, filters, revision, retry]);
  useEffect(() => { if (active && pane.current) pane.current.scrollTop = scroll.current; }, [active]);

  const navigate = (path: string) => {
    sequence.current++; setLoading(true); setError(''); setAnnouncement(''); select.current(null);
    focusAfterNavigation.current = true;
    displayed.current = 50;
    scroll.current = 0; if (pane.current) pane.current.scrollTop = 0;
    if (path === folder) setRetry(value => value + 1); else setFolder(path);
  };
  const loadMore = async () => {
    if (page?.nextOffset == null || loading) return;
    const id = sequence.current; setLoading(true);
    try { const next = await request(page.nextOffset); if (id === sequence.current) { displayed.current = page.entries.length + next.entries.length; setPage(previous => ({ ...next, entries: [...(previous?.entries ?? []), ...next.entries] })); } }
    catch (reason) { if (id === sequence.current) setError((reason as Error).message); }
    finally { if (id === sequence.current) setLoading(false); }
  };
  const parts = folder.split('/').filter(Boolean);
  const parent = parts.slice(0, -1).join('/');
  const entries = page?.folder === folder ? page.entries : [];
  return <section ref={pane} hidden={!active} className="results file-browser" aria-label="Archive files" aria-busy={loading} onScroll={event => { if (active) scroll.current = event.currentTarget.scrollTop; }} onKeyDown={event => {
    if (event.altKey && event.key === 'ArrowUp') { event.preventDefault(); if (folder) navigate(parent); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !(event.target as HTMLElement).closest('.file-list')) return;
    const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-entry-path]:not(:disabled)')];
    const index = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : Math.min(rows.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)));
    event.preventDefault(); rows[next]?.focus();
  }}>
    <div className="pane-heading"><span className="eyebrow">02 — Files</span><label className="inventory-control">Show<select aria-label="File inventory" value={inventory} onChange={event => {
      const next = event.target.value as BrowseRequest['inventory']; sequence.current++; displayed.current = 50; setLoading(true); setInventory(next); onInventory(next); setAnnouncement('');
    }}><option value="indexed">Indexed files</option><option value="all">All archive files</option></select></label></div>
    <nav className="breadcrumbs" aria-label="Archive location"><button disabled={!folder} onClick={() => navigate('')}>{root.split(/[\\/]/).pop()}</button>{parts.map((part, index) => <span key={index}><span aria-hidden="true"> / </span>{index === parts.length - 1 ? <span aria-current="location">{part}</span> : <button onClick={() => navigate(parts.slice(0, index + 1).join('/'))}>{part}</button>}</span>)}</nav>
    <div className="browse-location"><button disabled={!folder} onClick={() => navigate(parent)}>↑ Up</button><span className="small-copy" role="status">{loading ? 'Loading folder…' : error ? 'Folder needs attention.' : `${parts.at(-1) ?? 'Archive'} · ${entries.filter(entry => entry.kind === 'folder').length} folders · ${entries.filter(entry => entry.kind === 'file').length} files shown${page?.total !== null ? ` of ${page?.total ?? 0} entries` : ''}`}{announcement && ` ${announcement}`}</span></div>
    <p className="small-copy inventory-note">{inventory === 'indexed' ? 'Stored index only. Refresh to pick up changes. Empty folders and unsupported files appear in All archive files.' : 'Live folder listing. Filters apply to indexed files and search. Hidden, system, linked and ignored entries stay excluded.'}</p>
    {error ? <div className="notice" role="alert"><span>{error}</span><button onClick={() => setRetry(value => value + 1)}>Retry</button>{inventory === 'all' && <button onClick={() => { setInventory('indexed'); onInventory('indexed'); }}>Switch to indexed files</button>}</div> : <>
      {page?.limited && <div className="notice"><span>This listing is incomplete. Only the first 10,000 directory entries were considered.</span><button onClick={() => void api.revealEntry(root, folder).catch(reason => setError(reason.message))}>Show in folder</button></div>}
      {!loading && !entries.length ? <div className="empty-state"><h2>{inventory === 'all' ? 'This folder is empty.' : Object.values(filters).some(Boolean) ? 'No indexed files match these filters.' : 'No indexed files here yet.'}</h2><p>{inventory === 'all' ? 'No visible entries were found in this directory.' : 'Choose an ancestor or refresh the archive. Unsupported files and empty folders are available in All archive files.'}</p>{inventory === 'indexed' && Object.values(filters).some(Boolean) && <button onClick={onClearFilters}>Clear filters</button>}</div> : <div className="file-list">{entries.map(entry => <button key={entry.relativePath} className={`file-row ${entry.kind === 'file' && selection?.relativePath === entry.relativePath ? 'selected' : ''}`} data-entry-path={entry.relativePath} data-file-id={entry.kind === 'file' ? entry.fileId ?? undefined : undefined} disabled={loading} aria-pressed={entry.kind === 'file' ? selection?.relativePath === entry.relativePath : undefined} onClick={() => entry.kind === 'folder' ? navigate(entry.relativePath) : onActivate(entry)}>
        <span aria-hidden="true" className="file-glyph">{entry.kind === 'folder' ? '▱' : '≡'}</span><span className="file-name">{entry.name}</span><span className="file-meta">{entry.kind === 'folder' ? 'Folder ›' : <>{entry.type}{entry.status !== 'indexed' && <small>{fileState(entry.status)}</small>}</>}</span>
      </button>)}</div>}
      {page?.nextOffset != null && <button className="load-more" disabled={loading} onClick={() => void loadMore()}>Load more files</button>}
    </>}
  </section>;
}
