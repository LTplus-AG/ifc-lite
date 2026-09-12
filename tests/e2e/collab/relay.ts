/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A disposable signed relay for the browser acceptance (#4446): the built
 * `@ifc-lite/collab-server` binary on an ephemeral loopback port, with a
 * random `COLLAB_TOKEN_SECRET` and a temp data dir — exactly the
 * `docs/contributing/collaboration-testing.md` §3 flow, minus the fixed port.
 * No existing room, user or token is touched; `stop()` kills the process and
 * deletes its data.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface Relay {
  /** `ws://127.0.0.1:<port>` — what the viewer's `ifc-lite:collab:server-url` override is set to. */
  wsUrl: string;
  /** `http://127.0.0.1:<port>` — the token / blob routes. */
  httpUrl: string;
  port: number;
  dataDir: string;
  /** Lines the server wrote to stdout/stderr (for the evidence JSON and failure output). */
  log: string[];
  stop(): Promise<void>;
}

export function relayBinary(root: string): string {
  return join(root, 'packages/collab-server/dist/bin.js');
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

async function waitForHealth(httpUrl: string, child: ChildProcess, log: string[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`collab-server exited with ${child.exitCode}:\n${log.join('\n')}`);
    try {
      const res = await fetch(`${httpUrl}/healthz`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`collab-server did not become healthy within ${timeoutMs}ms:\n${log.join('\n')}`);
}

/** Start the relay; throws when the binary is not built (`pnpm --filter @ifc-lite/collab-server build`). */
export async function startRelay(root: string): Promise<Relay> {
  const bin = relayBinary(root);
  if (!existsSync(bin)) throw new Error(`${bin} missing — run pnpm --filter @ifc-lite/collab-server build`);
  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), 'ifc-lite-relay-'));
  const log: string[] = [];
  const child = spawn(process.execPath, [bin], {
    env: {
      ...process.env,
      COLLAB_HOST: '127.0.0.1',
      COLLAB_PORT: String(port),
      COLLAB_DATA_DIR: dataDir,
      COLLAB_TOKEN_SECRET: randomBytes(32).toString('hex'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const collect = (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) if (line.trim()) log.push(line);
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  const httpUrl = `http://127.0.0.1:${port}`;
  const stop = async (): Promise<void> => {
    if (child.exitCode === null) {
      child.kill();
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 5000);
        child.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    rmSync(dataDir, { recursive: true, force: true });
  };
  try {
    await waitForHealth(httpUrl, child, log, 30_000);
  } catch (err) {
    await stop();
    throw err;
  }
  return { wsUrl: `ws://127.0.0.1:${port}`, httpUrl, port, dataDir, log, stop };
}

/**
 * Mint a room token straight from the relay, the way the Share dialog does
 * (`POST /collab/token`). With `bearer` (the room admin's own token) it mints a
 * role-scoped invite; the negative control uses it to open an abandoned room.
 */
export async function mintToken(relay: Relay, roomId: string, role: string, bearer?: string): Promise<string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(`${relay.httpUrl}/collab/token`, { method: 'POST', headers, body: JSON.stringify({ roomId, role }) });
  if (!res.ok) throw new Error(`token mint failed (${res.status})`);
  const json = (await res.json()) as { token?: string };
  if (!json.token) throw new Error('token mint returned no token');
  return json.token;
}

/** Connected peers of `roomId` per the relay's `/metrics` gauge (0 when the room is not listed). */
export async function roomPeers(relay: Relay, roomId: string): Promise<number> {
  const res = await fetch(`${relay.httpUrl}/metrics`);
  if (!res.ok) throw new Error(`metrics failed (${res.status})`);
  const line = (await res.text()).split('\n').find((l) => l.startsWith('collab_room_peers{') && l.includes(`room="${roomId}"`));
  return line ? Number(line.trim().split(/\s+/).pop()) : 0;
}

/** Wait until the relay counts no peer in `roomId` (a left owner's socket is fully gone). */
export async function waitForRoomEmpty(relay: Relay, roomId: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await roomPeers(relay, roomId)) === 0) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`room ${roomId} still has peers after ${timeoutMs}ms`);
}
