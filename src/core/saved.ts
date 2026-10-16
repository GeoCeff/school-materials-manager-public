import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { SavedItem } from './model.js';

function valid(item: SavedItem): boolean {
  const text = (value: unknown, max: number) => typeof value === 'string' && value.length <= max && !value.includes('\0');
  const location = (value: unknown) => value === null || Number.isSafeInteger(value) && Number(value) > 0;
  return !!item && text(item.id, 36) && /^[a-f0-9-]{36}$/.test(item.id) && text(item.root, 32768) && isAbsolute(item.root) && text(item.title, 32768) &&
    (item.kind === 'bookmark' ? text(item.fileId, 32768) && location(item.page) && location(item.startLine) && typeof item.anchor === 'string' && /^[a-f0-9]{64}$/.test(item.anchor) :
      item.kind === 'search' && text(item.query, 500) && !!item.filters && typeof item.filters === 'object' && !Array.isArray(item.filters) &&
      Object.entries(item.filters).every(([key, value]) => ['year', 'semester', 'subject', 'type'].includes(key) && text(value, 200)));
}

// Saved intent lives outside the replaceable index. Passage IDs are deliberately never persisted.
export class SavedItems {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly directory: string) {}
  private async read(): Promise<SavedItem[]> {
    try {
      const raw = await readFile(join(this.directory, 'saved.json'), 'utf8');
      if (raw.length > 2_000_000) throw new Error();
      const data = JSON.parse(raw);
      if (data.version !== 1 || !Array.isArray(data.items) || data.items.length > 500 || !data.items.every(valid)) throw new Error();
      return data.items;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error('Saved items could not be read. The original saved.json has been retained in application data.');
    }
  }
  async list(root: string): Promise<SavedItem[]> { await this.queue.catch(() => {}); return (await this.read()).filter(item => item.root === root); }
  change(root: string, action: (items: SavedItem[]) => SavedItem[]): Promise<SavedItem[]> {
    const operation = this.queue.catch(() => {}).then(async () => {
      const all = await this.read(); const items = [...all.filter(item => item.root !== root), ...action(all.filter(item => item.root === root))];
      const data = JSON.stringify({ version: 1, items });
      if (items.length > 500 || data.length > 2_000_000) throw new Error('Saved items are full. Remove an item before saving another.');
      if (!items.every(valid)) throw new Error('Invalid saved item.');
      const temporary = join(this.directory, `saved-${randomUUID()}.tmp`);
      try { await writeFile(temporary, data, { flag: 'wx' }); await rename(temporary, join(this.directory, 'saved.json')); }
      finally { await rm(temporary, { force: true }); }
      return items.filter(item => item.root === root);
    });
    this.queue = operation; return operation;
  }
  async idle(): Promise<void> { await this.queue.catch(() => {}); }
}
