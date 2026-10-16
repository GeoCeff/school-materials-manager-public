export type Theme = 'system' | 'light' | 'dark';
export interface Filters { year?: string; semester?: string; subject?: string; type?: string }
export type SavedItem = { id: string; root: string; title: string } & (
  { kind: 'search'; query: string; filters: Filters } |
  { kind: 'bookmark'; fileId: string; page: number | null; startLine: number | null; anchor: string });
export interface BrowseRequest { folder: string; filters: Filters; offset: number; inventory: 'indexed' | 'all' }
export type BrowseEntry = { kind: 'folder'; relativePath: string; name: string } | {
  kind: 'file'; relativePath: string; name: string; fileId: string | null; passageId: number | null;
  type: string; status: string; size: string | null; modified: string | null;
};
export interface BrowsePage { folder: string; entries: BrowseEntry[]; total: number | null; nextOffset: number | null; limited: boolean }
export interface Labels { year: string | null; semester: string | null; subject: string | null; type: string }
export interface Job {
  id: string;
  kind: 'import' | 'refresh' | 'rebuild';
  state: 'discovering' | 'processing' | 'reconciling' | 'completed' | 'cancelled' | 'failed' | 'interrupted';
  total: number | null;
  processed: number;
  current: string | null;
  counts: { indexed: number; partial: number; noText: number; unchanged: number; failed: number; skipped: number; removed: number };
  errors: { path: string; category: string }[];
  pruningSkipped: boolean;
  started: string;
  ended?: string;
}
export interface Settings { version: 1; root: string | null; database: string | null; previousDatabase?: string | null; theme: Theme; lastJob: Job | null; ocr?: boolean }
export interface Status {
  root: string | null;
  available: boolean;
  canRefresh: boolean;
  problem: string | null;
  theme: Theme;
  ocr: boolean;
  files: number;
  passages: number;
  coverage: { indexed: number; partial: number; noText: number; failed: number; stale: number };
  options: { year: string[]; semester: string[]; subject: string[]; type: string[] };
  lastScan: string | null;
  job: Job | null;
}
