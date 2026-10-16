import { spawn } from 'node:child_process';
import { join } from 'node:path';

export const windowsPowerShell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');

// Native parsers need Windows/profile locations, never the desktop's tokens or development flags.
export function nativeEnvironment(): NodeJS.ProcessEnv {
  const allowed = new Set(['systemroot', 'windir', 'comspec', 'systemdrive', 'temp', 'tmp', 'userprofile', 'appdata', 'localappdata',
    'programdata', 'programfiles', 'programfiles(x86)', 'programw6432', 'commonprogramfiles', 'commonprogramfiles(x86)', 'commonprogramw6432']);
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toLowerCase())));
}

// Fixed scripts consume data on stdin; archive paths and content never become commands.
export function windowsTask(script: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
  if (process.platform !== 'win32') return Promise.reject(new Error('windows-required'));
  return new Promise((resolve, reject) => {
    const prelude = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::InputEncoding=[Text.Encoding]::UTF8; [Console]::OutputEncoding=[Text.Encoding]::UTF8; $inputData=[Console]::In.ReadToEnd() | ConvertFrom-Json; ";
    const child = spawn(windowsPowerShell,
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(prelude + script, 'utf16le').toString('base64')], { windowsHide: true, signal, env: nativeEnvironment() });
    let output = ''; let failed = false;
    const fail = (error: Error) => { if (failed) return; failed = true; child.kill(); reject(error); };
    const timeout = setTimeout(() => fail(new Error('native-timeout')), 20_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data: string) => { output += data; if (output.length > 16_000_000) fail(new Error('native-output-limit')); });
    child.stderr.resume();
    child.on('error', error => { clearTimeout(timeout); fail(error); });
    child.on('close', code => {
      clearTimeout(timeout);
      if (failed) return;
      if (code !== 0) { reject(new Error('native-extraction-failed')); return; }
      try { resolve(JSON.parse(output.replace(/^\uFEFF/, ''))); } catch { reject(new Error('native-extraction-failed')); }
    });
    child.stdin.on('error', error => fail(error));
    child.stdin.end(JSON.stringify(input));
  });
}
