import { spawn } from 'node:child_process';
import { lstat, opendir, readdir, realpath, stat } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import { SourceError, supportedExtensions } from './extract.js';
import { archivePath, excludedDirectories, within } from './paths.js';
import { nativeEnvironment, windowsPowerShell } from './windows.js';

function hiddenNames(directory: string, signal?: AbortSignal, root?: string): Promise<Set<string>> {
  if (process.platform !== 'win32') return Promise.resolve(new Set());
  // Windows attributes are not exposed by Node stat. Use a read-only, fixed native command with the path in the environment.
  return new Promise((resolve, reject) => {
    const command = root
      ? "$ErrorActionPreference='Stop'; $entryPath=$env:SMM_DIRECTORY; $hidden=@(); while ($entryPath -ne $env:SMM_ROOT) { $entry=Get-Item -LiteralPath $entryPath -Force; if (($entry.Attributes -band 6) -ne 0) { $hidden += $entry.Name }; $parent=[IO.Path]::GetDirectoryName($entryPath); if (!$parent -or $parent -eq $entryPath) { throw 'Outside archive' }; $entryPath=$parent }; $hidden | ConvertTo-Json -Compress"
      : "$ErrorActionPreference='Stop'; @(Get-ChildItem -LiteralPath $env:SMM_DIRECTORY -Force | Where-Object { ($_.Attributes -band 6) -ne 0 } | ForEach-Object Name) | ConvertTo-Json -Compress";
    const child = spawn(windowsPowerShell, ['-NoProfile', '-NonInteractive', '-Command', command],
      { windowsHide: true, env: { ...nativeEnvironment(), SMM_DIRECTORY: directory, SMM_ROOT: root ?? '' }, signal });
    let output = '';
    const timeout = setTimeout(() => { child.kill(); reject(new SourceError('attributes-timeout')); }, 10_000);
    child.stdout.on('data', data => { output += data; if (output.length > 128_000) { child.kill(); reject(new SourceError('attributes-limit')); } });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', code => {
      clearTimeout(timeout);
      if (code !== 0) { reject(new SourceError('unreadable-directory')); return; }
      try { const names = output.trim() ? JSON.parse(output) : []; resolve(new Set(Array.isArray(names) ? names : [names])); }
      catch { reject(new SourceError('attributes-unavailable')); }
    });
  });
}

export async function visibleArchivePath(root: string, path: string, signal?: AbortSignal): Promise<string> {
  const target = await archivePath(root, path);
  signal?.throwIfAborted();
  if (target !== root && (await hiddenNames(target, signal, root)).size) throw new SourceError('excluded-path');
  return archivePath(root, path);
}

export async function listArchiveDirectory(root: string, folder: string, signal?: AbortSignal) {
  const directory = await visibleArchivePath(root, folder, signal);
  if (!(await stat(directory)).isDirectory()) throw new SourceError('not-a-directory');
  const hidden = await hiddenNames(directory, signal);
  const entries: { kind: 'folder' | 'file'; relativePath: string; name: string }[] = [];
  let visited = 0; let limited = false;
  // ponytail: list at most 10,000 directory entries; use Explorer for larger folders before adding streaming inventory.
  for await (const entry of await opendir(directory)) {
    signal?.throwIfAborted();
    if (++visited > 10_000) { limited = true; break; }
    if (entry.name.startsWith('.') || hidden.has(entry.name) || entry.isSymbolicLink() || (entry.isDirectory() && excludedDirectories.has(entry.name.toLowerCase()))) continue;
    if (entry.isDirectory() || entry.isFile()) entries.push({ kind: entry.isDirectory() ? 'folder' : 'file', relativePath: [folder, entry.name].filter(Boolean).join('/'), name: entry.name });
  }
  await visibleArchivePath(root, folder, signal);
  entries.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'folder' ? -1 : 1) || a.name.localeCompare(b.name) || a.name.localeCompare(b.name, 'en', { sensitivity: 'variant' }));
  return { entries, limited };
}

export async function discover(root: string, signal?: AbortSignal, progress?: (count: number) => void) {
  root = resolve(root);
  if (!(await stat(root)).isDirectory() || await realpath(root) !== root) throw new SourceError('unavailable-root');
  const files: string[] = [];
  const errors: { path: string; category: string }[] = [];
  let skipped = 0;
  const pending = [root];
  while (pending.length) {
    signal?.throwIfAborted();
    const directory = pending.pop()!;
    try {
      if ((await lstat(directory)).isSymbolicLink() || !within(root, await realpath(directory))) throw new SourceError('linked-directory');
      const hidden = await hiddenNames(directory, signal);
      const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (entry.name.startsWith('.') || hidden.has(entry.name) || entry.isSymbolicLink() || (entry.isDirectory() && excludedDirectories.has(entry.name.toLowerCase()))) { skipped++; continue; }
        const target = join(directory, entry.name);
        if (entry.isDirectory()) pending.push(target);
        else if (entry.isFile() && supportedExtensions.has(extname(entry.name).toLowerCase())) files.push(relative(root, target));
        else skipped++;
      }
      progress?.(files.length);
    } catch (error) {
      if (signal?.aborted) throw error;
      errors.push({ path: relative(root, directory) || '.', category: error instanceof SourceError ? error.category : 'unreadable-directory' });
    }
  }
  return { files: files.sort(), errors, skipped, complete: errors.length === 0 };
}
