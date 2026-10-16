import { useEffect, useState } from 'react';
import type { ArchiveAPI } from '../desktop/bridge.js';

export function PdfPreview({ api, fileId, initialPage }: { api: ArchiveAPI; fileId: string; initialPage: number }) {
  const [page, setPage] = useState(initialPage);
  const [rendered, setRendered] = useState<Awaited<ReturnType<ArchiveAPI['document']>> | null>(null);
  const [error, setError] = useState('');
  const [zoom, setZoom] = useState(100);
  const [retry, setRetry] = useState(0);
  const [jump, setJump] = useState(String(initialPage));
  useEffect(() => {
    let current = true; setRendered(null); setError(''); setJump(String(page));
    void api.document(fileId, page).then(value => { if (current) setRendered(value); }).catch(error => { if (current) setError(/\bpdf-render-limit\b/.test(error.message) ? 'This PDF page exceeds the safe image or canvas limits. Its preview is unavailable; the original file is unchanged.' : /\bextraction-resource-limit\b/.test(error.message) ? 'The isolated PDF parser reached its Windows memory limit. This preview is unavailable; the original file is unchanged.' : /\bparser-containment-unavailable\b/.test(error.message) ? 'Windows PDF containment could not be established. This preview is unavailable; restart the app or check its installation.' : error.message); });
    return () => { current = false; void api.cancelDocument().catch(() => {}); };
  }, [api, fileId, page, retry]);
  const current = rendered?.page === page ? rendered : null;
  return <section className="pdf-viewer" aria-label="PDF page viewer">
    <div className="pdf-toolbar"><div className="button-row"><button disabled={page <= 1} aria-label="Previous PDF page" onClick={() => setPage(value => value - 1)}>←</button>
      <span role="status">Page {page}{current ? ` of ${current.pages}` : ''}</span><button disabled={!current || page >= current.pages} aria-label="Next PDF page" onClick={() => setPage(value => value + 1)}>→</button></div>
      <label>Zoom <select value={zoom} onChange={event => setZoom(Number(event.target.value))}>{[100,150,200].map(value => <option key={value} value={value}>{value === 100 ? 'Fit width' : `${value}%`}</option>)}</select></label></div>
    <form className="pdf-jump" onSubmit={event => { event.preventDefault(); const target = Number(jump); if (current && Number.isInteger(target) && target >= 1 && target <= current.pages) setPage(target); }}><label>Go to page <input aria-label="Go to PDF page" type="number" min={1} max={current?.pages ?? 1000} required value={jump} onChange={event => setJump(event.target.value)} /></label><button disabled={!current}>Go</button></form>
    {error ? <div role="alert"><p>{error}</p><button onClick={() => setRetry(value => value + 1)}>Retry page</button></div> : !current ? <p className="pdf-loading" role="status">Rendering page {page}…</p> :
      <div className="pdf-canvas" tabIndex={0} aria-label="Scrollable PDF page"><img src={current.image} width={current.width} height={current.height} style={{ width: `${zoom}%` }} alt={`Original PDF page ${page}. Extracted text is available in the Text view.`} /></div>}
    <p className="small-copy">Rendered locally from the original PDF. Use Text view to read or copy its indexed passage.</p>
  </section>;
}
