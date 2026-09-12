/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Process plumbing shared by the relay acceptance's two child processes
 * (`relay.ts`, `preview.ts`): an ephemeral loopback port, a stdout/stderr
 * line collector for the evidence JSON, and a kill that falls back to
 * SIGKILL when the child ignores the polite one.
 */

import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';

/** A port nobody holds on 127.0.0.1 right now (bind :0, read it back, release). */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close();
        reject(new Error('could not allocate a port'));
        return;
      }
      const { port } = addr;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

/** Push every non-blank line the child writes to stdout/stderr onto `log`. */
export function collectOutput(child: ChildProcess, log: string[]): void {
  const collect = (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) if (line.trim()) log.push(line);
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
}

/**
 * Kill a plain node child (spawned without a shell, so `kill()` reaches it)
 * and wait for it to exit; SIGKILL after `graceMs`.
 */
export function stopProcess(child: ChildProcess, graceMs = 5000): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, graceMs);
    child.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
    child.kill();
  });
}
