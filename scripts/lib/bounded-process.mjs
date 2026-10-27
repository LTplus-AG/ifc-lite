/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isMainEntry } from './is-main-entry.mjs';

/** A watchdog outside the test process kills its entire process group even
 * when a runner ignores SIGTERM or leaks a child holding the output pipe open.
 */
export function boundedSpawnSync(bin, args, options) {
  const { timeout, ...rest } = options;
  const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), String(timeout), bin, ...args], rest);
  if (run.status === 124) run.error = Object.assign(new Error('hard timeout'), { code: 'ETIMEDOUT' });
  return run;
}

if (isMainEntry(import.meta.url)) {
  const [milliseconds, bin, ...args] = process.argv.slice(2);
  const timeout = Number(milliseconds);
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || !bin) throw new Error('Expected positive timeout, binary and arguments');
  const child = spawn(bin, args, { detached: process.platform !== 'win32', stdio: 'inherit' });
  function kill() {
    if (!child.pid) return;
    if (process.platform === 'win32') {
      const result = spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
      if (result.error) console.error(result.error.message);
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
  let expired = false;
  const timer = setTimeout(() => { expired = true; kill(); }, timeout);
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => { kill(); process.exit(128); });
  child.on('error', (error) => { clearTimeout(timer); console.error(error.message); process.exitCode = 127; });
  child.on('close', (code) => {
    clearTimeout(timer);
    kill(); // Retire any descendants left behind by a runner which exited first.
    process.exitCode = expired ? 124 : (code ?? 1);
  });
}
