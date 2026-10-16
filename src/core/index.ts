import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join } from 'node:path';
import { discover, listArchiveDirectory, visibleArchivePath } from './discovery.js';
import { extractBounded, previewPdf, SourceError, supportedExtensions } from './extract.js';
import { Library } from './library.js';
import type { BrowseEntry, BrowsePage, BrowseRequest, Filters, Job, Settings, Status, Theme } from './model.js';
import { archiveRelative, inferLabels, within } from './paths.js';
import { SavedItems } from './saved.js';

export class ArchiveService {
  private settings: Settings = { version: 1, root: null, database: null, theme: 'system', lastJob: null };
  private library?: Library;
  private candidate: string | null = null;
  private controller?: AbortController;
  private running?: Promise<Job>;
  private problem: string | null = null;
  private corruptSettings = false;
  private writeQueue: Promise<void> = Promise.resolve();
  private lastEmission = 0;
  private browseController?: AbortController;
  private documentController?: AbortController;
  private documentRequest = 0;
  private readonly savedItems: SavedItems;
  constructor(private readonly dataDirectory: string, private readonly onProgress: (job: Job) => void = () => {}) { this.savedItems = new SavedItems(dataDirectory); }

  async init(): Promise<void> {
    await mkdir(this.dataDirectory, { recursive: true });
    try {
      const raw = await readFile(join(this.dataDirectory, 'settings.json'), 'utf8');
      if (raw.length > 256_000) throw new Error('settings-limit');
      const parsed = JSON.parse(raw) as Settings;
      if (parsed.version !== 1 || !['system', 'light', 'dark'].includes(parsed.theme) || (parsed.ocr !== undefined && typeof parsed.ocr !== 'boolean') ||
        (parsed.root !== null && (typeof parsed.root !== 'string' || !isAbsolute(parsed.root) || parsed.root.length > 32768)) ||
        (parsed.database !== null && !/^library-[a-f0-9-]{36}\.sqlite$/.test(parsed.database)) ||
        (parsed.previousDatabase && !/^library-[a-f0-9-]{36}\.sqlite$/.test(parsed.previousDatabase)) ||
        (parsed.lastJob && (!/^[a-f0-9-]{36}$/.test(parsed.lastJob.id) || !['import','refresh','rebuild'].includes(parsed.lastJob.kind) ||
          !['discovering','processing','reconciling','completed','cancelled','failed','interrupted'].includes(parsed.lastJob.state) ||
          !Number.isSafeInteger(parsed.lastJob.processed) || parsed.lastJob.processed < 0 ||
          (parsed.lastJob.total !== null && (!Number.isSafeInteger(parsed.lastJob.total) || parsed.lastJob.total < parsed.lastJob.processed)) ||
          typeof parsed.lastJob.started !== 'string' || typeof parsed.lastJob.pruningSkipped !== 'boolean' ||
          (parsed.lastJob.current !== null && typeof parsed.lastJob.current !== 'string') ||
          !parsed.lastJob.counts || !['indexed','partial','noText','unchanged','failed','skipped','removed'].every(key => Number.isSafeInteger(parsed.lastJob!.counts[key as keyof Job['counts']]) && parsed.lastJob!.counts[key as keyof Job['counts']] >= 0) ||
          !Array.isArray(parsed.lastJob.errors) || parsed.lastJob.errors.length > 200 || parsed.lastJob.errors.some(entry => typeof entry?.path !== 'string' || typeof entry?.category !== 'string')))) throw new Error('invalid-settings');
      this.settings = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.problem = 'Saved settings could not be read. Choose the archive folder again; existing index files are retained.';
        this.corruptSettings = true;
      }
    }
    if (this.settings.root && this.settings.database) {
      try {
        if (!(await lstat(join(this.dataDirectory, this.settings.database))).isFile()) throw new Error('missing-index');
        this.library = await Library.open(this.settings.root, join(this.dataDirectory, this.settings.database), true);
        this.library.validate();
      } catch { this.library?.close(); this.library = undefined; this.problem = 'The search index could not be opened. Rebuild it from the archive folder.'; }
    }
    if (this.settings.lastJob && ['discovering', 'processing', 'reconciling'].includes(this.settings.lastJob.state)) {
      const abandoned = `library-${this.settings.lastJob.id}.sqlite`;
      if (abandoned !== this.settings.database && abandoned !== this.settings.previousDatabase) {
        await rm(join(this.dataDirectory, abandoned), { force: true }).catch(() => {
          this.problem ??= 'An unused index could not be removed from application data. You can retry indexing.';
        });
      }
      this.settings.lastJob = { ...this.settings.lastJob, state: 'interrupted', current: null, pruningSkipped: true, ended: new Date().toISOString() };
      await this.save();
    }
  }
  private save(): Promise<void> {
    this.writeQueue = this.writeQueue.catch(() => {}).then(async () => {
      if (this.corruptSettings) {
        await copyFile(join(this.dataDirectory, 'settings.json'), join(this.dataDirectory, `settings-unreadable-${randomUUID()}.json`));
        this.corruptSettings = false;
      }
      const target = join(this.dataDirectory, 'settings.json');
      const temporary = join(this.dataDirectory, `settings-${randomUUID()}.tmp`);
      try { await writeFile(temporary, JSON.stringify(this.settings, null, 2), { flag: 'wx' }); await rename(temporary, target); }
      finally { await rm(temporary, { force: true }); }
    });
    return this.writeQueue;
  }
  async prepareRoot(rootPath: string): Promise<string> {
    if (this.running) throw new Error('Stop the current import before choosing another folder.');
    const root = await realpath(rootPath);
    if (!(await stat(root)).isDirectory() || within(root, await realpath(this.dataDirectory))) throw new Error('Choose an accessible archive folder outside application data.');
    this.candidate = root;
    return root;
  }
  async setTheme(theme: Theme): Promise<void> {
    if (!['system', 'light', 'dark'].includes(theme)) throw new Error('Invalid theme.');
    const previous = this.settings.theme; this.settings.theme = theme;
    try { await this.save(); } catch (error) { this.settings.theme = previous; throw error; }
  }
  async setOcr(enabled: boolean): Promise<void> {
    if (typeof enabled !== 'boolean') throw new Error('Invalid OCR preference.');
    if (this.running) throw new Error('Stop indexing before changing OCR.');
    const previous = this.settings.ocr; this.settings.ocr = enabled;
    try { await this.save(); } catch (error) { this.settings.ocr = previous; throw error; }
  }
  saved() { return this.savedItems.list(this.settings.root ?? ''); }
  async saveSearch(query: string, filters: Filters) {
    if (!this.library || !query.trim()) throw new Error('Enter a search first.');
    this.library.searchPage(query, filters, 0);
    const root = this.library.root;
    const clean = Object.fromEntries(Object.entries(filters).filter(([, value]) => value));
    return this.savedItems.change(root, items => items.some(item => item.kind === 'search' && item.query === query && JSON.stringify(item.filters) === JSON.stringify(clean)) ? items :
      [...items, { id: randomUUID(), root, kind: 'search', title: query, query, filters: clean }]);
  }
  async saveBookmark(id: string, passageId: number) {
    const library = this.library;
    if (!library) throw new Error('Index the archive first.');
    const preview = await library.preview(id, passageId);
    if (this.library !== library) throw new Error('The archive changed. Try again.');
    const root = library.root;
    const anchor = createHash('sha256').update(preview.text).digest('hex');
    return this.savedItems.change(root, items => items.some(item => item.kind === 'bookmark' && item.fileId === id && item.page === preview.page && item.startLine === preview.startLine && item.anchor === anchor) ? items :
      [...items, { id: randomUUID(), root, kind: 'bookmark', title: preview.relativePath, fileId: id, page: preview.page, startLine: preview.startLine, anchor }]);
  }
  removeSaved(id: string) { return this.savedItems.change(this.settings.root ?? '', items => items.filter(item => item.id !== id)); }
  async openBookmark(id: string) {
    const library = this.library;
    const item = (await this.saved()).find(item => item.id === id);
    if (!library || this.library !== library || item?.kind !== 'bookmark') throw new Error('This bookmark is unavailable in the current archive.');
    const preview = await library.bookmark(item.fileId, item.page, item.startLine, item.anchor);
    if (this.library !== library) throw new Error('The archive changed. Open Saved again.');
    return preview;
  }
  cancelDocument(): void { this.documentRequest++; this.documentController?.abort(); }
  async document(id: string, page: number) {
    const request = ++this.documentRequest;
    const library = this.library;
    if (!library) throw new Error('The search index is unavailable.');
    const path = await library.resolveFile(id);
    if (request !== this.documentRequest) throw new Error('PDF preview cancelled.');
    if (extname(path).toLowerCase() !== '.pdf') throw new Error('Only PDF documents have page previews.');
    if (!Number.isSafeInteger(page) || page < 1 || page > 1000) throw new Error('Invalid PDF page.');
    this.documentController?.abort();
    const controller = this.documentController = new AbortController();
    const before = await stat(path, { bigint: true });
    try {
      const result = await previewPdf(path, page, controller.signal);
      const after = await stat(await library.resolveFile(id), { bigint: true });
      if (this.library !== library || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) throw new Error('This document changed. Open its preview again.');
      controller.signal.throwIfAborted();
      return result;
    } finally { if (this.documentController === controller) this.documentController = undefined; }
  }
  async status(): Promise<Status> {
    const root = this.library?.root ?? this.settings.root;
    let available = false;
    if (root) { try { available = (await stat(root)).isDirectory() && await realpath(root) === root; } catch {} }
    return { root, available, canRefresh: !!this.library, theme: this.settings.theme, ocr: this.settings.ocr ?? false, problem: this.problem, job: this.settings.lastJob,
      ...(this.library?.summary() ?? { files: 0, passages: 0, coverage: { indexed: 0, partial: 0, noText: 0, failed: 0, stale: 0 }, options: { year: [], semester: [], subject: [], type: [] }, lastScan: null }) };
  }
  private emit(job: Job, force = false): void {
    if (force || Date.now() - this.lastEmission >= 150) { this.lastEmission = Date.now(); this.onProgress(structuredClone(job)); }
  }
  collectionCoverage(root: string, paths: string[]): {path:string;status:string|null}[] | null {
    if(root!==this.settings.root || !this.library)return null;
    return this.library.collectionCoverage(paths);
  }
  async start(kind: Job['kind']): Promise<Job> {
    if (this.running) return structuredClone(this.settings.lastJob!);
    const root = kind === 'import' ? this.candidate : this.settings.root;
    if (!root) throw new Error('Choose an archive folder first.');
    if (kind === 'refresh' && !this.library) throw new Error('Rebuild the index before refreshing.');
    const job: Job = { id: randomUUID(), kind, state: 'discovering', total: null, processed: 0, current: null,
      counts: { indexed: 0, partial: 0, noText: 0, unchanged: 0, failed: 0, skipped: 0, removed: 0 }, errors: [], pruningSkipped: true, started: new Date().toISOString() };
    this.settings.lastJob = job;
    this.controller = new AbortController();
    // Establish job ownership before awaiting persistence, so concurrent requests cannot start a second writer.
    this.running = this.run(job, root, this.controller.signal);
    this.emit(job, true);
    return structuredClone(job);
  }
  cancel(): void { this.controller?.abort(); }
  async assertIdle(): Promise<void> { if (this.running) throw new Error('Stop indexing before clearing local data.'); await this.writeQueue; await this.savedItems.idle(); }
  async reloadAfterRemoval(): Promise<void> {
    this.settings = { version: 1, root: null, database: null, theme: this.settings.theme, lastJob: null };
    this.candidate = null; this.problem = null; this.corruptSettings = false;
    await this.init();
  }
  async whenIdle(): Promise<Job | null> { return this.running ? this.running : this.settings.lastJob; }

  private async run(job: Job, root: string, signal: AbortSignal): Promise<Job> {
    const replacement = job.kind !== 'refresh';
    const firstImport = job.kind === 'import' && !this.settings.root;
    const name = replacement ? `library-${job.id}.sqlite` : this.settings.database!;
    let working: Library | undefined;
    let activated = false;
    try {
      await this.save();
      if (replacement) {
        working = await Library.open(root, join(this.dataDirectory, name));
        if (firstImport) {
          const oldRoot = this.settings.root; const oldName = this.settings.database;
          this.settings.root = root; this.settings.database = name;
          try { await this.save(); } catch (error) { this.settings.root = oldRoot; this.settings.database = oldName; throw error; }
          this.library = working; activated = true;
        }
      } else working = this.library!;
      const discovery = await discover(root, signal, count => { job.current = `${count} eligible files found`; this.emit(job); });
      job.counts.skipped = discovery.skipped;
      job.errors.push(...discovery.errors.slice(0, 200));
      job.total = discovery.files.length;
      job.state = 'processing'; this.emit(job, true);
      for (const path of discovery.files) {
        if (signal.aborted) throw new SourceError('cancelled');
        job.current = path; this.emit(job);
        const ocr = this.settings.ocr ?? false;
        const outcome = await working.indexFile(path, { force: replacement, signal, extractor: file => extractBounded(file, signal, ocr), extractorVersion: extname(path).toLowerCase() === '.pdf' ? ocr ? 5 : 4 : 2 });
        if (outcome.status === 'cancelled') throw new SourceError('cancelled');
        job.processed++;
        const count = outcome.status === 'no-text' ? 'noText' : ['failed', 'stale'].includes(outcome.status) ? 'failed' : outcome.status;
        job.counts[count as keyof Job['counts']]++;
        if (outcome.error && job.errors.length < 200) job.errors.push({ path, category: outcome.error });
        this.emit(job);
      }
      if (signal.aborted) throw new SourceError('cancelled');
      if (discovery.complete) {
        job.state = 'reconciling'; this.emit(job, true);
        // Check availability again immediately before treating absent paths as deletions.
        if (!(await stat(root)).isDirectory() || await realpath(root) !== root) throw new SourceError('unavailable-root');
        job.counts.removed = working.reconcile(discovery.files); job.pruningSkipped = false;
      }
      if (replacement && !firstImport && (!discovery.complete || job.counts.failed)) throw new SourceError('replacement-incomplete');
      working.validate();
      if (discovery.complete && !job.counts.failed) working.markScanned(new Date().toISOString());
      if (replacement && !activated) {
        const previous = this.library;
        const oldRoot = this.settings.root; const oldName = this.settings.database; const olderBackup = this.settings.previousDatabase;
        this.settings.root = root; this.settings.database = name; this.settings.previousDatabase = oldName;
        try { await this.save(); } catch (error) { this.settings.root = oldRoot; this.settings.database = oldName; this.settings.previousDatabase = olderBackup; throw error; }
        this.library = working; activated = true;
        previous?.close();
        if (olderBackup && olderBackup !== name && olderBackup !== oldName) await rm(join(this.dataDirectory, olderBackup), { force: true }).catch(() => {});
      }
      this.problem = null;
      job.state = 'completed';
    } catch (error) {
      job.state = signal.aborted || (error instanceof SourceError && error.category === 'cancelled') ? 'cancelled' : 'failed';
      job.pruningSkipped = true;
      if (job.state === 'failed' && job.errors.length < 200) job.errors.push({ path: '.', category: error instanceof SourceError ? error.category : 'indexing-failed' });
    } finally {
      if (replacement && !activated) {
        working?.close();
        // The generated UUID name is owned by this job; no archive or renderer path reaches cleanup.
        await rm(join(this.dataDirectory, name), { force: true }).catch(() => {
          this.problem ??= 'An unused index could not be removed from application data. You can retry indexing.';
        });
      }
      job.current = null; job.ended = new Date().toISOString();
      try { await this.save(); } catch { this.problem = 'Changes could not be saved. Check available disk space and restart.'; }
      this.running = undefined; this.controller = undefined; this.emit(job, true);
    }
    return structuredClone(job);
  }
  search(query: string, filters: Filters, offset: number) { return this.library?.searchPage(query, filters, offset) ?? { results: [], total: 0, nextOffset: null }; }
  async browse(request: BrowseRequest): Promise<BrowsePage> {
    let folder = archiveRelative(request.folder);
    if (!Number.isSafeInteger(request.offset) || request.offset < 0 || request.offset > 1_000_000 || !['indexed', 'all'].includes(request.inventory)) throw new Error('Invalid file page.');
    this.browseController?.abort();
    if (request.inventory === 'indexed') {
      if (!this.library) throw new Error('The index is unavailable. Rebuild it to browse indexed files, or choose All archive files.');
      if (!this.running && this.settings.lastJob?.state === 'completed' && !this.settings.lastJob.pruningSkipped) {
        while (folder && !this.library.hasFolder(folder)) folder = folder.split('/').slice(0, -1).join('/');
      }
      return this.library.browse(folder, request.filters, folder === request.folder ? request.offset : 0);
    }
    const root = this.settings.root;
    if (!root) throw new Error('Choose an archive folder first.');
    const controller = this.browseController = new AbortController();
    try {
      const listing = await listArchiveDirectory(root, folder, controller.signal);
      const entries: BrowseEntry[] = [];
      for (const entry of listing.entries.slice(request.offset, request.offset + 50)) {
        controller.signal.throwIfAborted();
        if (entry.kind === 'folder') { entries.push({ ...entry, kind: 'folder' }); continue; }
        const info = await lstat(join(root, entry.relativePath), { bigint: true });
        if (!info.isFile() || info.isSymbolicLink()) continue;
        const indexed = this.library?.root === root ? this.library.inventoryFile(entry.relativePath) : null;
        const supported = supportedExtensions.has(extname(entry.name).toLowerCase());
        entries.push({ ...indexed, ...entry, kind: 'file', fileId: indexed?.fileId ?? null, passageId: indexed?.passageId ?? null,
          type: supported ? indexed?.type ?? inferLabels(root, entry.relativePath).type : extname(entry.name).slice(1).toUpperCase() || 'File',
          status: indexed?.fileId ? indexed.status : supported ? 'not-indexed' : 'unsupported', size: info.size.toString(), modified: info.mtimeNs.toString() });
      }
      controller.signal.throwIfAborted();
      if (this.settings.root !== root) throw new Error('The archive changed. Browse again.');
      return { folder, entries, total: listing.limited ? null : listing.entries.length, nextOffset: request.offset + 50 < listing.entries.length ? request.offset + 50 : null, limited: listing.limited };
    } catch (error) {
      if (controller.signal.aborted) throw new Error('Folder request superseded.');
      throw new Error(error instanceof SourceError && ['linked-source', 'outside-root', 'excluded-path'].includes(error.category)
        ? 'This folder is outside the visible archive boundary.' : 'This folder could not be read. Check that it is available and you have permission.');
    }
  }
  async resolveEntry(root: string, path: string): Promise<string> {
    if (!root || this.settings.root !== root) throw new Error('The archive changed. Browse again.');
    const target = await visibleArchivePath(root, path);
    const info = await lstat(target);
    if ((!info.isFile() && !info.isDirectory()) || info.isSymbolicLink() || this.settings.root !== root) throw new Error('This archive entry is unavailable.');
    return target;
  }
  options(filters: Filters) { return this.library?.filterOptions(filters) ?? { year: [], semester: [], subject: [], type: [] }; }
  preview(id: string, passage: number) { if (!this.library) throw new Error('Index the archive first.'); return this.library.preview(id, passage); }
  matches(id: string, query: string) { return this.library?.matches(id, query) ?? []; }
  resolveFile(id: string) { if (!this.library) throw new Error('The search index is unavailable.'); return this.library.resolveFile(id); }
  async close(): Promise<void> { this.browseController?.abort(); this.cancelDocument(); this.cancel(); await this.whenIdle(); await this.writeQueue; await this.savedItems.idle(); this.library?.close(); this.library = undefined; }
}
