import { useEffect, useState } from 'react';
import type { ArchiveAPI } from '../desktop/bridge.js';
import type { ClearChoices, ClearReview } from '../core/local-data.js';

const labels: Record<keyof ClearChoices, string> = {
  indexes: 'Forget archives: all active, previous and interrupted indexes, folder settings and indexing history',
  saved: 'All saved searches and bookmarks, across archives',
  collection: 'Collection catalog: account/course metadata, review text, history, mappings and download staging',
  copies: 'Review individual managed copies in the current archive',
};
export function LocalDataPanel({ api, onComplete }: { api: ArchiveAPI; onComplete: () => Promise<void> }) {
  const [choices, setChoices] = useState<ClearChoices>({ indexes: false, saved: false, collection: false, copies: false });
  const [review, setReview] = useState<ClearReview | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState('');
  useEffect(() => () => { void api.clearCancel?.().catch(() => {}); }, [api]);
  async function prepare() {
    setBusy(true); setMessage(''); setReview(null); setSelected([]);
    try { setReview(await api.clearReview(choices)); } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!review) return;
    setBusy(true); setMessage('');
    try {
      const result = await api.clearExecute(review.id, selected);
      setReview(null); setSelected([]);
      setMessage(result ? `${result.removed} files removed. ${result.preserved.length} copies preserved. ${result.failures.length ? result.failures.join(' · ') : 'No removal failures reported.'}` : 'Cancelled. No data removed.');
      if (result) await onComplete();
    } catch (error) { setReview(null); setMessage(`${(error as Error).message} Review the remaining data before retrying.`); }
    finally { setBusy(false); }
  }
  return <section className="local-data-panel" aria-labelledby="local-data-title"><h3 id="local-data-title">Forget archive / Clear local data</h3>
    <p className="small-copy">Stop indexing and pause collection first. Choices apply to this Windows app profile. Connections, their account identity and tokens remain; use Collect → Disconnect separately. Confirmed removal disables daily collection. Removing the catalog loses tracking of retained copies.</p>
    <fieldset disabled={busy}><legend>Choose what to remove</legend>{(Object.keys(labels) as (keyof ClearChoices)[]).map(key => <label className="check-control" key={key}><input type="checkbox" checked={choices[key]} onChange={event => { setChoices({ ...choices, [key]: event.target.checked }); setReview(null); setSelected([]); void api.clearCancel(); }} />{labels[key]}</label>)}</fieldset>
    <button disabled={busy || !Object.values(choices).some(Boolean)} onClick={() => void prepare()}>{busy ? 'Working…' : 'Review removal scope'}</button>
    {review && <div aria-label="Removal scope"><p>Current archive: <span className="path">{review.root ?? 'None'}</span></p><p>{review.appFiles.length} app files; {selected.length} of {review.copies.length} eligible copies selected. Review expires after five minutes.</p>
      <details><summary>Exact application files ({review.appFiles.length})</summary><ul>{review.appFiles.map(name => <li key={name}>{name}</li>)}</ul></details>
      {review.copies.length > 0 && <fieldset disabled={busy}><legend>Select the exact managed copies to delete</legend>{review.copies.map(copy => <label className="check-control" key={copy.path}><input type="checkbox" checked={selected.includes(copy.path)} onChange={event => setSelected(event.target.checked ? [...selected, copy.path] : selected.filter(path => path !== copy.path))} /><span className="source-path">{copy.path}</span></label>)}</fieldset>}
      {review.preserved.length > 0 && <details><summary>Edited, missing or unverifiable copies preserved ({review.preserved.length})</summary><ul>{review.preserved.map(path => <li key={path}>{path}</li>)}</ul></details>}
      <p className="small-copy">Originals, untracked files, unselected copies and directory names remain. Indexes retain readable extracted text unless selected above. Deleting files cannot guarantee erasure from SSDs, backups or sync history.</p>
      <div className="button-row"><button disabled={busy || !review.appFiles.length && !selected.length} onClick={() => void remove()}>Continue to Windows confirmation</button><button disabled={busy} onClick={() => { setReview(null); void api.clearCancel(); }}>Cancel review</button></div>
    </div>}
    <p className="small-copy" role="status">{message}</p>
  </section>;
}
