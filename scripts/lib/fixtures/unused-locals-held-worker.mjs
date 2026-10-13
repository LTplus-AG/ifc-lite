/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A genuine worker startup gate; it never replaces pnpm/tsc or its result.
if (process.argv[1]?.endsWith('/unused-locals-worker.mjs')) {
  const dir = process.argv[3];
  await fetch(`${process.env.UNUSED_LOCALS_GATE}/${encodeURIComponent(dir)}?pid=${process.pid}`, {
    signal: AbortSignal.timeout(15000),
  });
  if (process.env.UNUSED_LOCALS_FAIL_EXEC_PACKAGE === dir) process.env.PATH = '/missing-unused-locals-compiler';
  if (process.env.UNUSED_LOCALS_KILL_PACKAGE === dir) process.kill(process.pid, 'SIGKILL');
}
