/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WORKERS = 2;
const WORKER = fileURLToPath(new URL('./unused-locals-worker.mjs', import.meta.url));
const MAX_BUFFER = 32 * 1024 * 1024;

function stop(child, signal) {
  try {
    // Each worker owns a process group, including its synchronous pnpm/tsc
    // descendants. A failed capture must not leave a compiler running behind it.
    if (process.platform === 'win32') child.kill(signal);
    else if (child.pid) process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

function decode(stdout, dir) {
  const result = JSON.parse(stdout);
  if (!result || Object.keys(result).sort().join(',') !== 'count,dir,unmeasurable'
    || result.dir !== dir || !Number.isSafeInteger(result.count) || result.count < 0
    || typeof result.unmeasurable !== 'boolean') {
    throw new Error(`unused-locals worker returned an invalid result for ${dir}`);
  }
  return result;
}

/** #7546: all discovered package outcomes, with at most two real compiler jobs.
 * No result or baseline verdict escapes before every owned child has settled. */
export async function measurePackages(root, dirs) {
  if (new Set(dirs).size !== dirs.length) throw new Error('unused-locals package discovery contained duplicates');
  const results = new Map();
  const failed = [];
  const active = new Set();
  let next = 0;
  let interrupted;
  const interrupt = signal => {
    interrupted = signal;
    for (const child of active) stop(child, signal);
  };
  const onInt = () => interrupt('SIGINT');
  const onTerm = () => interrupt('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  function measure(dir) {
    return new Promise(resolve => {
      const child = execFile(process.execPath, [WORKER, root, dir], {
        cwd: root, encoding: 'utf8', maxBuffer: MAX_BUFFER,
        detached: process.platform !== 'win32',
      }, (error, stdout, stderr) => {
        active.delete(child);
        if (error) {
          stop(child, 'SIGKILL');
          console.error(`❌ check-unused-locals worker failed for ${dir}; no count is accepted.`);
          if (stdout) console.error(stdout);
          if (stderr) console.error(stderr);
          failed.push(dir);
        } else {
          try { results.set(dir, decode(stdout, dir)); }
          catch (failure) {
            console.error(failure.message);
            failed.push(dir);
          }
        }
        resolve();
      });
      active.add(child);
    });
  }
  async function run() {
    while (!interrupted && next < dirs.length) {
      const dir = dirs[next++];
      await measure(dir);
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(WORKERS, dirs.length) }, run));
    if (interrupted) throw new Error(`unused-locals interrupted by ${interrupted}; no verdict or baseline update`);
    if (failed.length || results.size !== dirs.length || dirs.some(dir => !results.has(dir))) {
      throw new Error(`unused-locals did not measure every package: ${failed.join(', ')}`);
    }
    // Keep the original discovered order for global diagnostics and baseline bytes.
    return dirs.map(dir => results.get(dir));
  } finally {
    process.removeListener('SIGINT', onInt);
    process.removeListener('SIGTERM', onTerm);
    for (const child of active) stop(child, 'SIGKILL');
  }
}
