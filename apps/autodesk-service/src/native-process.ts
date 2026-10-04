/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { ServiceError } from './upstream.js';

export async function scratch<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'ifclite-autodesk-'));
  try { return await run(directory); }
  finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}
/** No shell. Request token is passed only through stdin, with bounded protocol output. */
export function runNative(command: string, args: readonly string[], cwd: string, input: string | undefined, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOME', 'LANG', 'LC_ALL', 'DOTNET_ROOT', 'DOTNET_SYSTEM_GLOBALIZATION_INVARIANT'].includes(key)));
    const child = spawn(command, [...args], { cwd, env: environment, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let output = ''; let killed = false;
    const kill = () => {
      killed = true;
      if (process.platform === 'win32' && child.pid) {
        const tree = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        tree.on('error', () => child.kill());
      } else child.kill('SIGKILL');
    };
    const abort = () => kill();
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.length > 64_000) kill();
    });
    child.stdin.on('error', () => kill());
    child.on('error', () => {
      signal.removeEventListener('abort', abort);
      reject(new ServiceError(503, 'worker-unavailable', 'The native Autodesk importer could not start.'));
    });
    child.on('close', (code) => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(signal.reason);
      else if (code !== 0 || killed) reject(new ServiceError(502, 'conversion-failed', 'Autodesk could not export this model. Retry the current version or download IFC from the source application.'));
      else resolve(output);
    });
    child.stdin.end(input);
    if (signal.aborted) kill();
  });
}
export async function readArtifact(directory: string, path: string, maxBytes: number): Promise<Uint8Array> {
  const child = relative(directory, path);
  if (!child || isAbsolute(child) || child === '..' || child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new ServiceError(502, 'invalid-artifact', 'The native importer returned an invalid artifact.');
  }
  const size = (await stat(path)).size;
  if (!size || size > maxBytes) throw new ServiceError(413, 'artifact-limit', 'The converted model exceeds the configured import limit.');
  return readFile(path);
}
