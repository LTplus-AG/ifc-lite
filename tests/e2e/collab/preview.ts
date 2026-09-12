/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A private `vite preview` of THIS checkout's viewer build on an ephemeral
 * port, for the relay acceptance (#4446).
 *
 * The config's top-level webServer serves the viewer on :3000 with
 * `reuseExistingServer: true` — which happily reuses a preview started by
 * another checkout (a sibling worktree running its own E2E) and then tests
 * someone else's build. This spec pins what it tests: it serves
 * `apps/viewer/dist` itself, on a port nobody else holds, and stops it.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

export interface ViewerPreview {
  /** `http://127.0.0.1:<port>` */
  url: string;
  port: number;
  stop(): Promise<void>;
}

export function viewerDist(root: string): string {
  return join(root, 'apps/viewer/dist/index.html');
}

async function freePort(): Promise<number> {
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

function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 5000);
    child.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
    // The vite binary is a plain node process here (no shell), so kill() reaches it.
    child.kill();
  });
}

/** Serve the built viewer; throws when `apps/viewer/dist` is missing. */
export async function startViewerPreview(root: string): Promise<ViewerPreview> {
  if (!existsSync(viewerDist(root))) throw new Error(`${viewerDist(root)} missing — run pnpm turbo build --filter=@ifc-lite/viewer`);
  const viteBin = join(root, 'apps/viewer/node_modules/vite/bin/vite.js');
  if (!existsSync(viteBin)) throw new Error(`${viteBin} missing — run pnpm install`);
  const port = await freePort();
  const log: string[] = [];
  const child = spawn(process.execPath, [viteBin, 'preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], {
    cwd: join(root, 'apps/viewer'),
    env: { ...process.env, BROWSER: 'none' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const collect = (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) if (line.trim()) log.push(line);
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`vite preview exited with ${child.exitCode}:\n${log.join('\n')}`);
    try {
      const res = await fetch(`${url}/`);
      if (res.ok) return { url, port, stop: () => stopProcess(child) };
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  await stopProcess(child);
  throw new Error(`vite preview did not come up within 60s:\n${log.join('\n')}`);
}
