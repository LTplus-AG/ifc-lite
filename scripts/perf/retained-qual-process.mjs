/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// These qualification runners use POSIX /usr/bin/time and /proc. Each measured
// command owns a detached process group, including the time wrapper and workers.
export const DEFAULT_TIMEOUT_MS = 45 * 60 * 1000;
export const STDERR_TAIL_BYTES = 8192;

export function sampleTimeout(value = DEFAULT_TIMEOUT_MS) {
  const ms = Number(value);
  if (!Number.isSafeInteger(ms) || ms < 1 || ms > 2147483647) {
    throw new Error('--timeout-ms must be a positive integer no greater than 2147483647');
  }
  return ms;
}

/** Bound even a wrapper whose descendants keep its pipes open after it exits. */
export function waitForProcess(child, timeoutMs) {
  return new Promise(resolve => {
    let timedOut = false, cleanupTimer, spawnError;
    const finish = (code, signal) => {
      clearTimeout(timer);
      clearTimeout(cleanupTimer);
      resolve({ code, signal, timedOut, spawnError });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') spawnError = error; }
      // Bound teardown too (e.g. uninterruptible I/O). The row remains a timeout,
      // with any kill error retained; it can never turn into a successful sample.
      cleanupTimer = setTimeout(() => {
        child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
        finish(null, 'SIGKILL');
      }, 5000);
    }, Math.max(1, timeoutMs));
    child.once('error', error => { spawnError = error; finish(null, null); });
    child.once('close', finish);
  });
}
