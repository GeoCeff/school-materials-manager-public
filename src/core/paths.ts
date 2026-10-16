import { lstat, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { SourceError, supportedExtensions } from './extract.js';
import type { Labels } from './model.js';

export const excludedDirectories = new Set(['node_modules', 'dist', 'build', 'out', '__pycache__', 'venv', 'env', 'target', 'coverage', 'system volume information', '$recycle.bin']);
export function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}
export function fileId(path: string): string { return process.platform === 'win32' ? path.toLowerCase() : path; }
export function archiveRelative(path: string): string {
  if (typeof path !== 'string' || path.length > 32768 || path.includes('\0') || isAbsolute(path) || /^[\\/]/.test(path)) throw new SourceError('outside-root');
  const parts = path ? path.split(/[\\/]/) : [];
  if (parts.includes('..')) throw new SourceError('outside-root');
  if (parts.some(part => !part || part.startsWith('.') || /[\u0000-\u001f<>:"|?*]/u.test(part) || /[. ]$/.test(part) ||
    /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part) || excludedDirectories.has(part.toLowerCase()))) throw new SourceError('excluded-path');
  return parts.join('/');
}
export async function archivePath(root: string, relativePath: string): Promise<string> {
  relativePath = archiveRelative(relativePath);
  if ((await lstat(root)).isSymbolicLink() || await realpath(root) !== root) throw new SourceError('linked-source');
  const target = resolve(root, relativePath);
  if (!within(root, target)) throw new SourceError('outside-root');
  let current = root;
  for (const segment of relativePath ? relativePath.split('/') : []) {
    current = join(current, segment);
    if ((await lstat(current)).isSymbolicLink()) throw new SourceError('linked-source');
  }
  if (!within(root, await realpath(target))) throw new SourceError('outside-root');
  return target;
}
export async function sourcePath(root: string, relativePath: string): Promise<string> {
  if (!relativePath) throw new SourceError('outside-root');
  const target = await archivePath(root, relativePath);
  if (!(await stat(target)).isFile()) throw new SourceError('not-a-file');
  if (!supportedExtensions.has(extname(target).toLowerCase())) throw new SourceError('unsupported-type');
  return target;
}
export function inferLabels(root: string, path: string): Labels {
  const folders = [basename(root), ...path.split(/[\\/]/).slice(0, -1)];
  const year = folders.find(part => /\b\d{4}-\d{4}\b/.test(part)) ?? null;
  const semesterIndex = folders.findIndex(part => /^(?:(?:first|second|1st|2nd)\s+(?:semester|term)|midyear|summer)$/i.test(part));
  const subject = (semesterIndex >= 0 ? folders[semesterIndex + 1] : folders.find(part => /^[a-z]{2,}(?:\s+[a-z]+)?\s*\d{1,3}(?:\s+[a-z]+)?$/i.test(part))) ?? null;
  const extension = extname(path).toLowerCase();
  return { year, semester: semesterIndex >= 0 ? folders[semesterIndex]! : null, subject,
    type: extension === '.pdf' ? 'PDF' : extension === '.docx' ? 'Word' : extension === '.pptx' ? 'Slides' : extension === '.md' ? 'Markdown' : extension === '.txt' ? 'Text' : 'Code' };
}
