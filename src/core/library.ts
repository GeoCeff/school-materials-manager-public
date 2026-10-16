import { lstat, mkdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { extractBounded, SourceError, type Extraction, type Passage } from './extract.js';
import { archiveRelative, fileId, inferLabels, sourcePath, within } from './paths.js';
import type { BrowseEntry, BrowsePage, Filters, Labels, Status } from './model.js';

function filterSQL(filters: Filters) {
  const clauses: string[] = []; const parameters: string[] = [];
  for (const field of ['year', 'semester', 'subject', 'type'] as const) {
    const value = filters[field];
    if (value !== undefined && (typeof value !== 'string' || value.length > 200 || value.includes('\0'))) throw new Error('Invalid archive filter.');
    if (value) { clauses.push(value === '__other__' ? `f.${field} IS NULL` : `f.${field}=?`); if (value !== '__other__') parameters.push(value); }
  }
  return { where: clauses.length ? ` AND ${clauses.join(' AND ')}` : '', parameters };
}

export function queryExpression(query: string): string | null {
  if (typeof query !== 'string' || query.length > 500) throw new Error('Use a query of at most 500 characters.');
  if (!query.trim()) return null;
  if ((query.match(/"/g)?.length ?? 0) % 2) throw new Error('Close the quoted phrase before searching.');
  const terms = [...query.matchAll(/"([^"]*)"|([^\s"]+)/gu)].map(match => match[1] ?? match[2] ?? '').filter(term => /[\p{L}\p{N}]/u.test(term));
  if (terms.length > 32) throw new Error('Use at most 32 search terms.');
  return terms.length ? terms.map(term => `"${term.replaceAll('"', '""')}"`).join(' AND ') : null;
}

export interface SearchResult extends Passage, Labels {
  fileId: string; passageId: number; relativePath: string; status: string; error: string | null; matchCount: number; filenameOnly: boolean;
}
export interface SearchPage { results: SearchResult[]; total: number; nextOffset: number | null }
export interface Preview extends SearchResult { availability: 'available' | 'changed' | 'missing' | 'unsafe'; canOpen: boolean }

export class Library {
  private constructor(public readonly root: string, private readonly database: DatabaseSync) {}
  collectionCoverage(paths: string[]): {path:string;status:string|null}[] {
    const lookup=this.database.prepare('SELECT status FROM files WHERE id=?');
    return paths.map(path=>({path,status:(lookup.get(fileId(path))?.status as string|undefined)??null}));
  }

  static async open(rootPath: string, databasePath: string, storedRoot = false): Promise<Library> {
    const root = storedRoot ? resolve(rootPath) : await realpath(rootPath);
    if (!storedRoot && !(await stat(root)).isDirectory()) throw new Error('Choose a folder as the archive root.');
    const target = resolve(databasePath);
    if (within(root, target)) throw new Error('Keep the search index outside the source archive.');
    let existing = dirname(target);
    const suffix: string[] = [];
    while (true) {
      try { existing = await realpath(existing); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        suffix.unshift(basename(existing));
        const parent = dirname(existing);
        if (parent === existing) throw error;
        existing = parent;
      }
    }
    const canonicalTarget = join(existing, ...suffix, basename(target));
    if (within(root, canonicalTarget)) throw new Error('Keep the search index outside the source archive.');
    try {
      const info = await lstat(canonicalTarget);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('The index must be a regular file.');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await mkdir(dirname(canonicalTarget), { recursive: true });
    const database = new DatabaseSync(canonicalTarget, { timeout: 5_000 });
    try {
      const version = database.prepare('PRAGMA user_version').get()!.user_version;
      if (![0, 1, 2, 3].includes(Number(version))) throw new Error('The index version is newer than this app.');
      database.exec(`PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, status TEXT NOT NULL, error TEXT,
          year TEXT, semester TEXT, subject TEXT, type TEXT, size TEXT, modified TEXT, extractor INTEGER);
        CREATE TABLE IF NOT EXISTS passages (id INTEGER PRIMARY KEY, file_id TEXT NOT NULL REFERENCES files(id), text TEXT NOT NULL, page INTEGER, start_line INTEGER, end_line INTEGER, origin TEXT NOT NULL DEFAULT 'embedded');
        CREATE INDEX IF NOT EXISTS passages_by_file ON passages(file_id);
        CREATE VIRTUAL TABLE IF NOT EXISTS passage_search USING fts5(filename, text, tokenize='unicode61');`);
      if (version === 1) {
        database.exec('BEGIN');
        try {
          for (const column of ['year TEXT', 'semester TEXT', 'subject TEXT', 'type TEXT', 'size TEXT', 'modified TEXT', 'extractor INTEGER']) database.exec(`ALTER TABLE files ADD COLUMN ${column}`);
          const rows = database.prepare('SELECT id, path FROM files').all();
          for (const row of rows) {
            const labels = inferLabels(root, row.path as string);
            database.prepare('UPDATE files SET year=?, semester=?, subject=?, type=? WHERE id=?').run(labels.year, labels.semester, labels.subject, labels.type, row.id!);
          }
          database.exec('PRAGMA user_version=2; COMMIT');
        } catch (error) { database.exec('ROLLBACK'); throw error; }
      }
      if (version === 1 || version === 2) {
        database.exec('BEGIN');
        try { database.exec("ALTER TABLE passages ADD COLUMN origin TEXT NOT NULL DEFAULT 'embedded'; PRAGMA user_version=3; COMMIT"); }
        catch (error) { database.exec('ROLLBACK'); throw error; }
      } else database.exec('PRAGMA user_version=3');
      const configured = database.prepare("SELECT value FROM metadata WHERE key='root'").get()?.value;
      if (configured && configured !== root) throw new Error('This index belongs to another folder. Use a separate index.');
      database.prepare('INSERT OR IGNORE INTO metadata VALUES (?, ?)').run('root', root);
      return new Library(root, database);
    } catch (error) { database.close(); throw error; }
  }

  async indexFile(relativePath: string, options: { force?: boolean; signal?: AbortSignal; extractor?: (path: string) => Promise<Extraction>; extractorVersion?: number } = {}) {
    const target = resolve(this.root, relativePath);
    const path = relative(this.root, target);
    const id = fileId(path);
    const extractorVersion = options.extractorVersion ?? 2;
    try {
      await sourcePath(this.root, relativePath);
      const before = await stat(target, { bigint: true });
      const cached = this.database.prepare('SELECT * FROM files WHERE id=?').get(id);
      // ponytail: size/mtime can miss preserved-metadata edits; Rebuild bypasses reuse. Add hashing if real misses justify it.
      if (!options.force && cached && !['failed', 'stale'].includes(cached.status as string) && cached.size === before.size.toString() && cached.modified === before.mtimeNs.toString() && cached.extractor === extractorVersion) {
        return { status: 'unchanged', passages: 0, error: null };
      }
      const result = await (options.extractor ?? extractBounded)(target);
      if (options.signal?.aborted) throw new SourceError('cancelled');
      await sourcePath(this.root, path);
      const after = await stat(target, { bigint: true });
      if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ino !== after.ino ||
        result.source.size !== before.size.toString() || result.source.modified !== before.mtimeNs.toString() || result.source.inode !== before.ino.toString()) throw new SourceError('changed-during-extraction');
      const labels = inferLabels(this.root, path);
      this.database.exec('BEGIN IMMEDIATE');
      try {
        this.erasePassages(id);
        this.database.prepare(`INSERT INTO files VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET path=excluded.path, status=excluded.status, error=excluded.error, year=excluded.year,
          semester=excluded.semester, subject=excluded.subject, type=excluded.type, size=excluded.size, modified=excluded.modified, extractor=excluded.extractor`)
          .run(id, path, result.status, result.limitation ?? null, labels.year, labels.semester, labels.subject, labels.type, before.size.toString(), before.mtimeNs.toString(), extractorVersion);
        const insert = this.database.prepare('INSERT INTO passages (file_id, text, page, start_line, end_line, origin) VALUES (?, ?, ?, ?, ?, ?)');
        const searchInsert = this.database.prepare('INSERT INTO passage_search (rowid, filename, text) VALUES (?, ?, ?)');
        for (const passage of result.passages.length ? result.passages : [{ text: '', page: null, startLine: null, endLine: null }]) {
          const row = insert.run(id, passage.text, passage.page, passage.startLine, passage.endLine, passage.origin ?? 'embedded');
          searchInsert.run(row.lastInsertRowid, basename(path), passage.text);
        }
        this.database.exec('COMMIT');
      } catch (error) { this.database.exec('ROLLBACK'); throw error; }
      return { status: result.status, passages: result.passages.length, error: result.limitation ?? null };
    } catch (error) {
      const category = error instanceof SourceError ? error.category : (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'unavailable-source' : 'extraction-failed';
      if (options.signal?.aborted || category === 'cancelled') return { status: 'cancelled', passages: 0, error: null };
      if (!within(this.root, target) || target === this.root || ['outside-root', 'excluded-path', 'linked-source', 'not-a-file', 'unsupported-type'].includes(category)) return { status: 'failed', passages: 0, error: category };
      const existing = this.database.prepare("SELECT id, EXISTS(SELECT 1 FROM passages WHERE file_id=files.id AND text<>'') AS hasText FROM files WHERE id=?").get(id);
      const labels = inferLabels(this.root, path);
      this.database.exec('BEGIN');
      try {
        this.database.prepare(`INSERT INTO files (id,path,status,error,year,semester,subject,type) VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET status=excluded.status,error=excluded.error`)
          .run(id, path, existing?.hasText ? 'stale' : 'failed', category, labels.year, labels.semester, labels.subject, labels.type);
        if (!existing) {
          const row = this.database.prepare('INSERT INTO passages (file_id,text) VALUES (?,?)').run(id, '');
          this.database.prepare('INSERT INTO passage_search (rowid,filename,text) VALUES (?,?,?)').run(row.lastInsertRowid, basename(path), '');
        }
        this.database.exec('COMMIT');
      } catch (failure) { this.database.exec('ROLLBACK'); throw failure; }
      return { status: existing?.hasText ? 'stale' : 'failed', passages: 0, error: category };
    }
  }

  private erasePassages(id: string) {
    this.database.prepare('DELETE FROM passage_search WHERE rowid IN (SELECT id FROM passages WHERE file_id=?)').run(id);
    this.database.prepare('DELETE FROM passages WHERE file_id=?').run(id);
  }
  reconcile(discovered: string[]): number {
    const seen = new Set(discovered.map(fileId));
    const missing = this.database.prepare('SELECT id FROM files').all().filter(row => !seen.has(row.id as string));
    this.database.exec('BEGIN');
    try {
      for (const row of missing) { this.erasePassages(row.id as string); this.database.prepare('DELETE FROM files WHERE id=?').run(row.id!); }
      this.database.exec('COMMIT');
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
    return missing.length;
  }
  markScanned(timestamp: string): void { this.database.prepare('INSERT OR REPLACE INTO metadata VALUES (?,?)').run('last-scan', timestamp); }

  hasFolder(folder: string): boolean {
    const prefix = fileId(archiveRelative(folder) + '/');
    return !folder || !!this.database.prepare(`SELECT 1 FROM files WHERE substr(replace(id,char(92),'/'),1,?)=? LIMIT 1`).get([...prefix].length, prefix);
  }
  browse(folder: string, filters: Filters, offset: number): BrowsePage {
    folder = archiveRelative(folder);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) throw new Error('Invalid file page.');
    const prefix = folder ? folder + '/' : '';
    const prefixLength = [...prefix].length;
    const identityPrefix = fileId(prefix); const identityLength = [...identityPrefix].length;
    const { where, parameters } = filterSQL(filters);
    const base = `WITH descendants AS (
      SELECT f.*,replace(f.path,char(92),'/') AS fullPath,substr(replace(f.path,char(92),'/'),?) AS tail,
        replace(f.id,char(92),'/') AS identityPath,substr(replace(f.id,char(92),'/'),?) AS identityTail FROM files f
      WHERE substr(replace(f.id,char(92),'/'),1,?)=?${where}
    ), entries AS (
      SELECT CASE WHEN instr(tail,'/')>0 THEN 'folder' ELSE 'file' END AS kind,
        CASE WHEN instr(tail,'/')>0 THEN substr(fullPath,1,?-1+instr(tail,'/')) ELSE fullPath END AS relativePath,
        CASE WHEN instr(tail,'/')>0 THEN substr(tail,1,instr(tail,'/')-1) ELSE tail END AS name,
        CASE WHEN instr(tail,'/')=0 THEN id END AS fileId,
        CASE WHEN instr(identityTail,'/')>0 THEN substr(identityPath,1,?-1+instr(identityTail,'/')) ELSE identityPath END AS entryId,
        type,status,size,modified FROM descendants
    ), direct AS (SELECT * FROM entries GROUP BY entryId)`;
    const args = [prefixLength + 1, identityLength + 1, identityLength, identityPrefix, ...parameters, prefixLength, identityLength] as const;
    const total = Number(this.database.prepare(`${base} SELECT COUNT(*) AS count FROM direct`).get(...args)!.count);
    const rows = this.database.prepare(`${base}, paged AS MATERIALIZED (
      SELECT * FROM direct ORDER BY kind DESC,name COLLATE NOCASE,name,relativePath LIMIT 50 OFFSET ?
      ) SELECT *,CASE WHEN kind='file' THEN (SELECT id FROM passages WHERE file_id=paged.fileId ORDER BY page,start_line,id LIMIT 1) END AS passageId FROM paged
      ORDER BY kind DESC,name COLLATE NOCASE,name,relativePath`).all(...args, offset) as unknown as BrowseEntry[];
    const entries = rows.map(entry => entry.kind === 'folder' ? { kind: 'folder' as const, relativePath: entry.relativePath, name: entry.name } : entry);
    return { folder, entries, total, nextOffset: offset + entries.length < total ? offset + entries.length : null, limited: false };
  }
  inventoryFile(path: string): Extract<BrowseEntry, { kind: 'file' }> {
    const row = this.database.prepare(`SELECT f.id AS fileId,f.type,f.status,f.size,f.modified,
      (SELECT id FROM passages WHERE file_id=f.id ORDER BY page,start_line,id LIMIT 1) AS passageId FROM files f WHERE f.id=?`).get(fileId(path.replaceAll('/', process.platform === 'win32' ? '\\' : '/')));
    return { kind: 'file', relativePath: path, name: basename(path), fileId: null, passageId: null, type: inferLabels(this.root, path).type, status: 'not-indexed', size: null, modified: null, ...row } as Extract<BrowseEntry, { kind: 'file' }>;
  }

  search(query: string): SearchResult[] { return this.searchPage(query, {}, 0, 20).results; }
  searchPage(query: string, filters: Filters = {}, offset = 0, limit = 25): SearchPage {
    const expression = queryExpression(query);
    if (!expression) return { results: [], total: 0, nextOffset: null };
    const { where, parameters } = filterSQL(filters);
    const base = `FROM passage_search s JOIN passages p ON p.id=s.rowid JOIN files f ON f.id=p.file_id WHERE passage_search MATCH ?${where}`;
    const total = Number(this.database.prepare(`SELECT COUNT(DISTINCT f.id) AS count ${base}`).get(expression, ...parameters)!.count);
    const rows = this.database.prepare(`WITH matches AS MATERIALIZED (
      SELECT f.id AS fileId,p.id AS passageId,f.path AS relativePath,f.status,f.error,f.year,f.semester,f.subject,f.type,p.text,p.page,p.origin,
        p.start_line AS startLine,p.end_line AS endLine,bm25(passage_search,2.0,1.0) AS score,
        NOT EXISTS (SELECT rowid FROM passage_search WHERE rowid=s.rowid AND passage_search MATCH ?) AS filenameOnly ${base}
      ), ranked AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY fileId ORDER BY score,passageId) AS position,
        COUNT(*) OVER (PARTITION BY fileId) AS matchCount FROM matches)
      SELECT * FROM ranked WHERE position=1 ORDER BY score,relativePath,fileId LIMIT ? OFFSET ?`)
      .all(`text : (${expression})`, expression, ...parameters, limit, offset) as unknown as (Omit<SearchResult, 'filenameOnly'> & { filenameOnly: number })[];
    return { results: rows.map(row => ({ ...row, filenameOnly: Boolean(row.filenameOnly) })), total, nextOffset: offset + rows.length < total ? offset + rows.length : null };
  }

  matches(file: string, query: string): SearchResult[] {
    const expression = queryExpression(query);
    if (!expression) return [];
    const rows = this.database.prepare(`SELECT p.id AS passageId,p.text,p.page,p.origin,p.start_line AS startLine,p.end_line AS endLine,
        NOT EXISTS (SELECT rowid FROM passage_search WHERE rowid=s.rowid AND passage_search MATCH ?) AS filenameOnly
      FROM passage_search s JOIN passages p ON p.id=s.rowid WHERE passage_search MATCH ? AND p.file_id=?
      ORDER BY bm25(passage_search,2.0,1.0),p.id LIMIT 25`).all(`text : (${expression})`, expression, file);
    const source = this.database.prepare('SELECT * FROM files WHERE id=?').get(file);
    if (!source) throw new Error('This result is no longer indexed. Search again.');
    return rows.map(row => ({ ...source, ...row, fileId: file, relativePath: source.path, matchCount: rows.length, filenameOnly: Boolean(row.filenameOnly) })) as unknown as SearchResult[];
  }
  async resolveFile(id: string): Promise<string> {
    const row = this.database.prepare('SELECT path FROM files WHERE id=?').get(id);
    if (!row) throw new Error('This file is no longer indexed. Search again.');
    return sourcePath(this.root, row.path as string);
  }
  async preview(id: string, passageId: number): Promise<Preview> {
    const row = this.database.prepare(`SELECT f.*, f.path AS relativePath,f.id AS fileId,p.id AS passageId,p.text,p.page,p.origin,p.start_line AS startLine,p.end_line AS endLine
      FROM files f JOIN passages p ON p.file_id=f.id WHERE f.id=? AND p.id=?`).get(id, passageId);
    if (!row) throw new Error('This passage changed. Search again to load its latest version.');
    let availability: Preview['availability'] = 'available';
    try {
      const target = await this.resolveFile(id);
      const info = await stat(target, { bigint: true });
      if (info.size.toString() !== row.size || info.mtimeNs.toString() !== row.modified) availability = 'changed';
    } catch (error) { availability = error instanceof SourceError && ['linked-source', 'outside-root'].includes(error.category) ? 'unsafe' : 'missing'; }
    return { ...row, text: (row.text as string).slice(0, 4_000), availability,
      canOpen: ['.pdf', '.txt', '.md'].includes(extname(row.path as string).toLowerCase()) && !['missing', 'unsafe'].includes(availability),
      matchCount: 1, filenameOnly: !row.text } as unknown as Preview;
  }
  bookmark(id: string, page: number | null, startLine: number | null, anchor: string): Promise<Preview> {
    const row = this.database.prepare('SELECT id,text FROM passages WHERE file_id=? AND page IS ? AND start_line IS ? ORDER BY id').all(id, page, startLine)
      .find(row => createHash('sha256').update(String(row.text)).digest('hex') === anchor);
    if (!row) throw new Error('This bookmarked location is no longer indexed. Search for the document again.');
    return this.preview(id, Number(row.id));
  }
  summary(): Pick<Status, 'files' | 'passages' | 'coverage' | 'options' | 'lastScan'> {
    const coverage = { indexed: 0, partial: 0, noText: 0, failed: 0, stale: 0 };
    for (const row of this.database.prepare('SELECT status,COUNT(*) AS count FROM files GROUP BY status').all()) {
      const key = row.status === 'no-text' ? 'noText' : row.status;
      if (Object.hasOwn(coverage, key as string)) coverage[key as keyof typeof coverage] = Number(row.count);
    }
    return { files: Object.values(coverage).reduce((a, b) => a + b, 0),
      passages: Number(this.database.prepare("SELECT COUNT(*) AS count FROM passages WHERE text<>''").get()!.count),
      coverage, options: this.filterOptions({}), lastScan: this.database.prepare("SELECT value FROM metadata WHERE key='last-scan'").get()?.value as string ?? null };
  }
  filterOptions(filters: Filters): Status['options'] {
    const options = { year: [], semester: [], subject: [], type: [] } as Status['options'];
    const clauses: string[] = []; const values: string[] = [];
    for (const field of ['year', 'semester', 'subject', 'type'] as const) {
      options[field] = this.database.prepare(`SELECT DISTINCT ${field} AS value FROM files${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY ${field}`)
        .all(...values).map(row => row.value === null ? '__other__' : String(row.value));
      const selected = filters[field];
      if (selected && options[field].includes(selected)) {
        clauses.push(selected === '__other__' ? `${field} IS NULL` : `${field}=?`);
        if (selected !== '__other__') values.push(selected);
      }
    }
    return options;
  }
  validate(): void { if (this.database.prepare('PRAGMA quick_check').get()!.quick_check !== 'ok') throw new Error('The search index needs rebuilding.'); }
  close(): void { this.database.close(); }
}
