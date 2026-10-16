export type CollectionSource = 'manual' | 'google' | 'uvec';
export interface SourceCourse { id: string; title: string; archived: boolean }
export interface CourseMapping { courseId: string; year: string; semester: string; subject: string }
export type CollectionFailureKind = 'temporary' | 'attention' | 'changed' | 'permanent';
export interface CollectionItem {
  id: string; key: string; courseId: string; course: string; title: string;
  kind: 'local' | 'file' | 'note' | 'reference'; bucket: string; extension: string;
  revision: string; sourceURL: string; size: number | null;
  text?: string; localPath?: string; fileId?: string; exportMime?: string; downloadURL?: string;
  state: 'ready' | 'published' | 'unchanged' | 'failed' | 'excluded'; message?: string; path?: string; failure?: CollectionFailureKind;
}
export interface CollectionPlan {
  id: string; root: string; source: CollectionSource; account: string; label: string;
  year: string; semester: string; created: string; items: CollectionItem[]; gaps: string[]; mappings?: CourseMapping[];
}
export interface CollectionJob {
  id: string; planId: string; state: 'running' | 'paused' | 'cancelled' | 'interrupted' | 'completed' | 'completed-with-gaps';
  processed: number; total: number; published: number; unchanged: number; failed: number;
  bytes: number; current: string | null; message: string; started: string;
}
export interface CollectionSnapshot { plan: CollectionPlan | null; job: CollectionJob | null }
export interface CollectionOptions { year: string; semester: string }
export interface CollectionPreflight {
  planId: string; items: { id: string; path: string; problem: string | null }[];
  estimatedBytes: number; unknownSizes: number; freeBytes: number; problems: string[];
}
export interface CollectionSuggestion {
  id: string; courseId: string; subject: string; reason: string;
}
export interface CollectionAssistance {
  planId: string; suggestions: CollectionSuggestion[];
  duplicates: { ids: string[]; reason: string }[];
  excerpts: { id: string; title: string; text: string; source: string }[];
}
export interface SchoolSupport {
  id: string; name: string; level: 'manual' | 'experimental' | 'verified'; origin: string | null; coverage: string; requirement: string;
}
export interface CollectionCoverage { id: string; state: 'searchable' | 'partial' | 'no-text' | 'stale' | 'failed' | 'pending' | 'unsupported' | 'not-collected' | 'index-unavailable' }
export interface ConnectionStatus {
  google: { configured: boolean; bundled: boolean; connected: boolean; label: string; attachments: boolean; announcements: boolean; submissions: boolean };
  uvec: { connected: boolean; label: string };
  authenticating: boolean; problem: string;
}
export interface CollectionStatus extends CollectionSnapshot {
  connections: ConnectionStatus; courses: SourceCourse[];
  schools: SchoolSupport[];
  schedule: { enabled: boolean; next: string | null; source: CollectionSource | null; state: 'off' | 'waiting' | 'running' | 'retrying' | 'attention'; message: string; lastRun: string | null; lastSuccess: string | null };
}
export interface ScanSelection extends CollectionOptions {
  source: 'google' | 'uvec'; courseIds: string[];
}
export interface CollectionAPI {
  status(): Promise<CollectionStatus>;
  configureGoogle(): Promise<void>;
  connectGoogle(options: { attachments: boolean; announcements: boolean; submissions: boolean }): Promise<void>;
  connectUvec(): Promise<void>;
  cancelAuth(): Promise<void>;
  disconnect(source: 'google' | 'uvec'): Promise<void>;
  courses(source: 'google' | 'uvec'): Promise<SourceCourse[]>;
  scan(selection: ScanSelection): Promise<void>;
  chooseFiles(options: CollectionOptions & { school: 'manual' | 'uvec'; course: string }): Promise<void>;
  start(ids: string[]): Promise<void>;
  stop(action: 'pause' | 'cancel'): Promise<void>;
  resume(): Promise<void>;
  retryFailed(): Promise<void>;
  organize(mappings: CourseMapping[]): Promise<void>;
  preflight(ids: string[]): Promise<CollectionPreflight>;
  coverage(): Promise<CollectionCoverage[]>;
  assistance(): Promise<CollectionAssistance>;
  setupCheck(source: 'google' | 'uvec'): Promise<{ checks: { name: string; state: 'ready' | 'missing' | 'unverified'; detail: string }[]; request?: string }>;
  supportText(): Promise<string>;
  exportSupport(): Promise<void>;
  schedule(enabled: boolean): Promise<void>;
  progress(listener: () => void): () => void;
}
