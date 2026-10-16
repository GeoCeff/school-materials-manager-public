import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ArchiveAPI } from '../desktop/bridge.js';
import type { SavedItem } from '../core/model.js';
import type { Preview } from '../core/library.js';

export function SavedPanel({ api, active, onSearch, onBookmark }: { api: ArchiveAPI; active: boolean; onSearch: (item: Extract<SavedItem, { kind: 'search' }>) => void; onBookmark: (item: Preview) => void }) {
  const [items, setItems] = useState<SavedItem[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const mounted = useRef(true);
  useLayoutEffect(() => { mounted.current = active; return () => { mounted.current = false; }; }, [active]);
  useEffect(() => { let current = true; setError(''); void api.saved().then(items => { if (current) setItems(items); }).catch(error => { if (current) setError(error.message); }); return () => { current = false; }; }, [api, retry]);
  async function action(run: () => Promise<void>) { setBusy(true); setError(''); try { await run(); } catch (error) { setError((error as Error).message); } finally { setBusy(false); } }
  async function remove(id: string, button: HTMLButtonElement) {
    const row = button.closest('article');
    const neighbor = row?.nextElementSibling?.querySelector<HTMLButtonElement>('.saved-item') ?? row?.previousElementSibling?.querySelector<HTMLButtonElement>('.saved-item');
    await action(async () => { const remaining = await api.removeSaved(id); if (mounted.current) setItems(remaining); });
    requestAnimationFrame(() => { if (mounted.current) (button.isConnected ? button : neighbor?.isConnected ? neighbor : document.querySelector<HTMLButtonElement>('button[aria-label="Close dialog"]'))?.focus(); });
  }
  return <><p className="small-copy">Saved for this archive. Bookmarks and searches stay available when you rebuild its index.</p>
    {error && <div role="alert"><p>{error}</p>{!items && <button onClick={() => setRetry(value => value + 1)}>Retry saved items</button>}</div>}{!items && !error && <p role="status">Loading saved items…</p>}{items?.length === 0 && <div className="empty-state"><h3>Keep a useful discovery.</h3><p>Save a search or bookmark a passage to return to it here.</p></div>}
    <div className="saved-list">{items?.map(item => <article key={item.id}><button className="saved-item" disabled={busy} onClick={() => item.kind === 'search' ? onSearch(item) : void action(async () => { const preview = await api.openBookmark(item.id); if (mounted.current) onBookmark(preview); })}>
      <span className="eyebrow">{item.kind === 'search' ? 'Search' : 'Bookmark'}</span><strong>{item.title}</strong><span className="small-copy">{item.kind === 'search' ? Object.values(item.filters).join(' · ') || 'All indexed files' : item.page ? `${item.title.toLowerCase().endsWith('.pptx') ? 'Slide' : 'PDF page'} ${item.page}` : item.startLine ? `${item.title.toLowerCase().endsWith('.docx') ? 'Paragraph' : 'Line'} ${item.startLine}` : 'Filename'}</span></button>
      <button disabled={busy} aria-label={`Remove ${item.title}`} onClick={event => void remove(item.id, event.currentTarget)}>Remove</button></article>)}</div></>;
}
