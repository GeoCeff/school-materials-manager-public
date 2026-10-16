import { randomUUID } from 'node:crypto';
import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ArchiveService } from './index.js';
import type { CollectionService } from './collection.js';

export interface ClearChoices { indexes: boolean; saved: boolean; collection: boolean; copies: boolean }
export interface ClearReview { id: string; choices: ClearChoices; root: string | null; appFiles: string[]; copies: { path: string; hash: string }[]; preserved: string[] }
export interface ClearResult { removed: number; failures: string[]; preserved: string[] }
export function clearChoices(value: unknown): ClearChoices {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 4 ||
    !['indexes','saved','collection','copies'].every(key => typeof (value as Record<string, unknown>)[key] === 'boolean') || !Object.values(value).some(Boolean)) throw new Error('Choose the local data to remove.');
  return { ...value } as ClearChoices;
}

// Never recursively delete an archive: unlink only individually reviewed, owned regular files.
export class LocalDataRemoval {
  private review?: { value: ClearReview; expires: number };
  constructor(private data: string, private archive: ArchiveService, private collection: CollectionService) {}
  private async regular(name: string): Promise<void> {
    if (await realpath(this.data) !== resolve(this.data) || (await lstat(this.data)).isSymbolicLink()) throw new Error('Application data must not be redirected.');
    if (name.startsWith('downloads/')) { const folder = join(this.data, 'downloads'); if ((await lstat(folder)).isSymbolicLink() || await realpath(folder) !== folder) throw new Error('Download staging was redirected.'); }
    const path = join(this.data, name); const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || await realpath(path) !== path) throw new Error('An application data file is not a regular owned file.');
  }
  private async targets(choices: ClearChoices): Promise<Omit<ClearReview, 'id'>> {
    await this.archive.assertIdle();
    if (this.collection.progress()?.state === 'running') throw new Error('Pause collection before clearing local data.');
    if (await realpath(this.data) !== resolve(this.data) || (await lstat(this.data)).isSymbolicLink()) throw new Error('Application data must not be redirected.');
    const names = await readdir(this.data);
    if (names.length > 10000) throw new Error('Too many application files to review safely.');
    const appFiles = names.filter(name =>
      choices.indexes && (/^library-[a-f0-9-]{36}\.sqlite(?:-wal|-shm|-journal)?$/.test(name) || /^settings(?:-unreadable-[a-f0-9-]{36})?\.json$/.test(name) || /^settings-[a-f0-9-]{36}\.tmp$/.test(name)) ||
      choices.saved && (/^saved\.json$/.test(name) || /^saved-[a-f0-9-]{36}\.tmp$/.test(name)) ||
      choices.collection && /^collection\.sqlite(?:-wal|-shm|-journal)?$/.test(name));
    if (choices.collection) {
      const downloads = join(this.data, 'downloads');
      try {
        if ((await lstat(downloads)).isSymbolicLink() || await realpath(downloads) !== downloads) throw new Error('Download staging was redirected.');
        for (const name of await readdir(downloads)) if (/^[a-f0-9-]{36}\.part$/.test(name)) appFiles.push(`downloads/${name}`);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    for (const name of appFiles) await this.regular(name);
    const root = (await this.archive.status()).root;
    const collected = choices.copies ? await this.collection.removalCopies(root) : { copies: [], preserved: [] };
    return { choices, root, appFiles: appFiles.sort(), ...collected };
  }
  async prepare(value: unknown): Promise<ClearReview> {
    this.review = undefined;
    const result = { id: randomUUID(), ...await this.targets(clearChoices(value)) };
    this.review = { value: result, expires: Date.now() + 5 * 60_000 };
    return structuredClone(result);
  }
  cancel(): void { this.review = undefined; }
  async execute(id: unknown, selected: unknown, beforeRemoval: () => Promise<void> = async () => {}): Promise<ClearResult> {
    const reviewed = this.review; this.review = undefined;
    if (!reviewed || reviewed.value.id !== id || reviewed.expires < Date.now()) throw new Error('Review the removal scope again.');
    if (!Array.isArray(selected) || selected.length > 10000 || new Set(selected).size !== selected.length || selected.some(path => typeof path !== 'string' || !reviewed.value.copies.some(copy => copy.path === path))) throw new Error('Select only copies in the removal review.');
    const { id: unused, ...scope } = reviewed.value;
    if (JSON.stringify(await this.targets(scope.choices)) !== JSON.stringify(scope)) throw new Error('Local data changed after review. Review the scope again.');
    const result: ClearResult = { removed: 0, failures: [], preserved: [...scope.preserved, ...scope.copies.filter(copy => !selected.includes(copy.path)).map(copy => copy.path)] };
    // Verify using the open catalog; keep the exact hashes after closing it.
    for (const copy of scope.copies.filter(copy => selected.includes(copy.path))) {
      await this.collection.verifyRemovalCopy(scope.root!, copy.path, copy.hash);
    }
    // Schedule changes are authorized only after the entire one-use review passes validation.
    await beforeRemoval();
    await this.archive.close();
    try {
      // The catalog remains open until copies are checked/unlinked, then closes before its own removal.
      for (const copy of scope.copies.filter(copy => selected.includes(copy.path))) {
        try { await this.collection.verifyRemovalCopy(scope.root!, copy.path, copy.hash); await rm(join(scope.root!, copy.path)); result.removed++; }
        catch { result.failures.push(`Collected copy retained: ${copy.path}`); }
      }
      await this.collection.close();
      // Remove the settings pointer before databases. On failure, preserve all indexes for recovery.
      let indexFailure = false;
      for (const name of [...scope.appFiles].sort((a,b) => Number(b === 'settings.json') - Number(a === 'settings.json'))) {
        if (result.failures.length && /^collection\.sqlite/.test(name) || indexFailure && /^library-/.test(name)) { result.failures.push(`Recovery file retained: ${name}`); continue; }
        try { await this.regular(name); await rm(join(this.data, name)); result.removed++; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; // SQLite may remove its WAL/SHM while closing.
          result.failures.push(`Application file retained: ${name}`); if (name === 'settings.json') indexFailure = true;
        }
      }
    } finally {
      await this.collection.close();
      await this.archive.reloadAfterRemoval(); await this.collection.reloadAfterRemoval();
    }
    return result;
  }
}
