import { readFileSync, renameSync, writeFileSync } from 'node:fs';
export interface Bounds { x: number; y: number; width: number; height: number }
export function restoreWindow(path: string, screens: Bounds[]): Bounds & { maximized: boolean } {
  let saved: Partial<Bounds> & { maximized?: boolean } = {};
  try { const raw = readFileSync(path, 'utf8'); if (raw.length < 1024) saved = JSON.parse(raw) ?? {}; } catch {}
  const valid = ['x','y','width','height'].every(key => Number.isSafeInteger(saved[key as keyof Bounds])) && Number(saved.width) > 0 && Number(saved.height) > 0;
  const display = valid ? screens.find(area => saved.x! < area.x + area.width && saved.x! + saved.width! > area.x && saved.y! < area.y + area.height && saved.y! + saved.height! > area.y) ?? screens[0]! : screens[0]!;
  const width = Math.min(display.width, Math.max(560, valid ? saved.width! : 1360));
  const height = Math.min(display.height, Math.max(520, valid ? saved.height! : 900));
  return { width, height, x: Math.round(Math.max(display.x, Math.min(valid ? saved.x! : display.x + (display.width - width) / 2, display.x + display.width - width))),
    y: Math.round(Math.max(display.y, Math.min(valid ? saved.y! : display.y + (display.height - height) / 2, display.y + display.height - height))), maximized: saved.maximized === true };
}
export function saveWindow(path: string, bounds: Bounds, maximized: boolean): void {
  try { writeFileSync(`${path}.tmp`, JSON.stringify({ ...bounds, maximized })); renameSync(`${path}.tmp`, path); } catch { /* ponytail: window position is optional; archive persistence has its own error handling. */ }
}
