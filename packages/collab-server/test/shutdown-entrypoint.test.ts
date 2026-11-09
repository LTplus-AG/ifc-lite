/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * SIGTERM to the shipped entrypoint with a peer still connected (PR #9486).
 *
 * bin.ts runs `handle.stop()` and only then `accessControl.flush()` and
 * `process.exit(0)`. When `stop()` hung on a live peer, the process never
 * exited: an orchestrator's follow-up SIGKILL then lost the room's final
 * compaction and any debounced claim/revocation write. This spawns the real
 * process, keeps a real y-websocket peer attached, and requires a clean,
 * prompt exit with the room compacted, and a claim made just before the
 * signal still honoured by a restarted server over the same data dir.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Y from 'yjs';
import { WebSocket } from 'ws';
import { WebsocketProvider } from 'y-websocket';
import { FilePersistence } from '../src/persistence.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.join(here, '..');
const repoRoot = path.join(pkgRoot, '..', '..');
const tsx = path.join(repoRoot, 'node_modules', '.bin', 'tsx');

const ROOM = 'sigterm-room';
const LATE_CLAIM = 'claimed-just-before-sigterm';

const children: ChildProcess[] = [];
let provider: WebsocketProvider | null = null;
let dataDir = '';

afterEach(() => {
  provider?.destroy();
  provider = null;
  for (const c of children.splice(0)) c.kill('SIGKILL');
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

/** Number of `[len:u32][bytes]` frames in a FilePersistence room log. */
function frameCount(file: string): number {
  if (!fs.existsSync(file)) return 0;
  const buf = fs.readFileSync(file);
  let n = 0;
  for (let off = 0; off + 4 <= buf.byteLength; n++) off += 4 + buf.readUInt32LE(off);
  return n;
}

async function until(cond: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Unauthenticated mint: a fresh room's first caller becomes its admin (200);
 *  a room already claimed refuses it (403). */
function mintRequest(base: string, roomId: string): Promise<Response> {
  return fetch(`${base}/collab/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roomId, role: 'admin' }),
  });
}

async function mint(base: string, roomId: string): Promise<string> {
  const res = await mintRequest(base, roomId);
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

interface Entrypoint {
  proc: ChildProcess;
  port: number;
  base: string;
  output: () => string;
  /** Exit code, or 'hung' if the process is still running after `ms`. */
  exitWithin: (ms: number) => Promise<number | null | 'hung'>;
}

/** Spawn the shipped entrypoint over `dir` with access control on. */
async function startEntrypoint(dir: string): Promise<Entrypoint> {
  // Hermetic: no ambient COLLAB_* setting may change what this asserts.
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('COLLAB_')),
  );
  const proc = spawn(tsx, [path.join(pkgRoot, 'src', 'bin.ts')], {
    env: {
      ...env,
      COLLAB_HOST: '127.0.0.1',
      COLLAB_PORT: '0',
      COLLAB_DATA_DIR: dir,
      COLLAB_TOKEN_SECRET: 'test-only-secret-'.padEnd(48, 'x'),
      COLLAB_BLOB_GC: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(proc);
  let output = '';
  proc.stdout?.on('data', (d) => (output += String(d)));
  proc.stderr?.on('data', (d) => (output += String(d)));
  const exited = new Promise<number | null>((resolve) => proc.once('exit', (code) => resolve(code)));
  await until(() => /listening at ws:\/\/[^:]+:\d+/.test(output), 20_000, `startup:\n${output}`);
  const port = Number(/listening at ws:\/\/[^:]+:(\d+)/.exec(output)?.[1]);
  return {
    proc,
    port,
    base: `http://127.0.0.1:${port}`,
    output: () => output,
    exitWithin: async (ms) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      return Promise.race([
        exited,
        new Promise<'hung'>((resolve) => {
          timer = setTimeout(() => resolve('hung'), ms);
        }),
      ]).finally(() => clearTimeout(timer));
    },
  };
}

describe('entrypoint SIGTERM with a live peer (PR #9486)', () => {
  it('PR #9486: exits 0 promptly, compacts the room, and the latest claim survives a restart', async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-sigterm-'));
    const first = await startEntrypoint(dataDir);
    const { port, base } = first;

    const doc = new Y.Doc();
    provider = new WebsocketProvider(`ws://127.0.0.1:${port}`, ROOM, doc, {
      WebSocketPolyfill: WebSocket as never,
      disableBc: true,
      params: { token: await mint(base, ROOM) },
    });
    const prov = provider;
    await new Promise<void>((resolve) => (prov.synced ? resolve() : prov.once('sync', () => resolve())));

    // Two separate edits -> two appended frames, so a single frame after exit
    // can only mean the shutdown compaction ran.
    const logFile = path.join(dataDir, `${encodeURIComponent(ROOM)}.log`);
    doc.getMap('m').set('a', 1);
    await until(() => frameCount(logFile) >= 1, 5_000, 'first frame');
    doc.getMap('m').set('b', 2);
    await until(() => frameCount(logFile) >= 2, 5_000, 'second frame');

    // A fresh claim schedules a debounced access-control write and SIGTERM
    // lands inside that window. The exit below must wait for it (flush), not
    // race it.
    await mint(base, LATE_CLAIM);
    expect(prov.wsconnected).toBe(true);
    first.proc.kill('SIGTERM');

    const code = await first.exitWithin(10_000);
    expect(code, `entrypoint did not exit cleanly after SIGTERM.\nOutput:\n${first.output().slice(-1500)}`).toBe(0);

    expect(frameCount(logFile)).toBe(1);
    const reloaded = new Y.Doc();
    const saved = await new FilePersistence({ dataDir }).load(ROOM);
    expect(saved).not.toBeNull();
    if (saved) Y.applyUpdate(reloaded, saved);
    expect(reloaded.getMap('m').toJSON()).toEqual({ a: 1, b: 2 });

    // The late claim is durable: a restarted server over the same data dir
    // still treats that room as claimed and refuses a second fresh-room
    // admin mint. The control room proves the restart grants unclaimed rooms,
    // so the refusal is the claim and not a broken mint route.
    const second = await startEntrypoint(dataDir);
    expect((await mintRequest(second.base, 'never-claimed-control')).status).toBe(200);
    expect((await mintRequest(second.base, LATE_CLAIM)).status).toBe(403);
    second.proc.kill('SIGTERM');
    expect(await second.exitWithin(10_000)).toBe(0);
  }, 45_000);

  // POSIX-only: a FIFO as the room log makes its load block until the test
  // feeds it, which is how a load can fail DURING shutdown deterministically.
  it.skipIf(process.platform === 'win32')(
    'PR #9486: when stop() fails (a room load rejects mid-shutdown) the claim flush still lands and the exit code is 1',
    async () => {
      dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-sigterm-fail-'));
      const first = await startEntrypoint(dataDir);
      const BLOCKED = 'blocked-room';
      const token = await mint(first.base, BLOCKED);
      const fifo = path.join(dataDir, `${encodeURIComponent(BLOCKED)}.log`);
      execFileSync('mkfifo', [fifo]);

      // The join authenticates, then its room load blocks reading the FIFO.
      const joiner = new WebSocket(`ws://127.0.0.1:${first.port}/${BLOCKED}?token=${encodeURIComponent(token)}`);
      joiner.on('error', () => {}); // the server drops it during shutdown; asserted via exit code
      const feed = await fs.promises.open(fifo, 'w'); // resolves once the server is reading

      await mint(first.base, LATE_CLAIM); // debounced claim write pending
      first.proc.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 50)); // shutdown is now unloading the blocked room
      // A frame whose payload is not a Yjs update: the load rejects.
      const frame = Buffer.alloc(6);
      frame.writeUInt32LE(2, 0);
      frame[4] = 0xff;
      frame[5] = 0xff;
      await feed.write(frame);
      await feed.close();

      const code = await first.exitWithin(10_000);
      expect(code, `expected a failed shutdown to exit 1.\nOutput:\n${first.output().slice(-1500)}`).toBe(1);
      expect(first.output()).toContain('shutdown error (continuing to flush)');
      joiner.terminate();

      fs.rmSync(fifo);
      const second = await startEntrypoint(dataDir);
      expect((await mintRequest(second.base, 'never-claimed-control')).status).toBe(200);
      expect((await mintRequest(second.base, LATE_CLAIM)).status).toBe(403);
      second.proc.kill('SIGTERM');
      expect(await second.exitWithin(10_000)).toBe(0);
    },
    45_000,
  );
});
