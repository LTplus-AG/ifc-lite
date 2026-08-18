/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Blob GC (#2790). Most of these are DATA-LOSS tests: the failure mode being
 * guarded against is deleting a blob some room still references, which is
 * silent, permanent geometry loss.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as Y from 'yjs';
import { geometryMap } from '@ifc-lite/collab';
import { FilePersistence } from '../src/persistence.js';
import { FsBlobStorage } from '../src/blob-route.js';
import {
  BlobGcWorker,
  collectLiveBlobRefs,
  collectPersistedBlobRefs,
  planBlobGc,
} from '../src/blob-gc.js';

const H = (c: string) => c.repeat(32);
const A = H('a');
const B = H('b');
const C = H('c');

let dataDir: string;
let blobsDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blob-gc-'));
  blobsDir = path.join(dataDir, 'blobs');
  fs.mkdirSync(blobsDir, { recursive: true });
});
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** A Y update whose geometry map references `hashes`. */
function updateReferencing(hashes: string[]): Uint8Array {
  const doc = new Y.Doc();
  const geom = geometryMap(doc);
  doc.transact(() => {
    hashes.forEach((h, i) => {
      geom.set(`g${i}`, new Y.Map<unknown>());
      (geom.get(`g${i}`) as Y.Map<unknown>).set('blobHash', h);
    });
  });
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

async function writeRoom(roomId: string, hashes: string[]) {
  await new FilePersistence({ dataDir }).append(roomId, updateReferencing(hashes));
}

/** Write a blob file with an explicit age in ms. */
function writeBlob(hash: string, ageMs: number) {
  const file = path.join(blobsDir, hash);
  fs.writeFileSync(file, Buffer.from([1, 2, 3]));
  const t = (Date.now() - ageMs) / 1000;
  fs.utimesSync(file, t, t);
}

const DAY = 24 * 60 * 60 * 1000;

async function plan(extra: { graceMs?: number } = {}) {
  const scan = await collectPersistedBlobRefs(dataDir);
  return planBlobGc({
    blobsDir,
    referenced: scan.refs,
    roomLogs: scan.roomLogs,
    graceMs: extra.graceMs ?? DAY,
  });
}

describe('blob gc', () => {
  it('deletes an old unreferenced blob and keeps an old referenced one', async () => {
    await writeRoom('room-1', [A]);
    writeBlob(A, 3 * DAY);
    writeBlob(B, 3 * DAY);

    const p = await plan();
    expect(p.deleteHashes).toEqual([B]);
    expect(p.kept).toBe(1);
  });

  it('the grace window protects a freshly uploaded unreferenced blob', async () => {
    await writeRoom('room-1', []);
    writeBlob(B, 60_000); // uploaded a minute ago, hash not in the doc yet

    expect((await plan()).deleteHashes).toEqual([]);

    // ...and the same blob, aged past the window, is collected.
    writeBlob(B, 3 * DAY);
    expect((await plan()).deleteHashes).toEqual([B]);
  });

  it('a reference from ANY room protects a shared blob', async () => {
    // Content-addressed blobs are shared; branch forks copy refs into sibling
    // rooms without re-uploading. A per-room scan would delete A here.
    await writeRoom('keeps-a', [A]);
    await writeRoom('dropped-a', [C]);
    writeBlob(A, 3 * DAY);
    writeBlob(C, 3 * DAY);

    expect((await plan()).deleteHashes).toEqual([]);
  });

  it('counts rooms that are persisted but not loaded in memory', async () => {
    // No RoomManager is passed at all: the scan is pure disk. A live-rooms-only
    // implementation would see zero references and delete A.
    await writeRoom('idle-room', [A]);
    writeBlob(A, 3 * DAY);

    const scan = await collectPersistedBlobRefs(dataDir);
    expect(scan.roomLogs).toBe(1);
    expect([...scan.refs]).toEqual([A]);
  });

  it('aborts when a non-empty room log parses to nothing', async () => {
    // `FilePersistence.load` returns null - it does NOT throw - for a corrupt
    // log. Treating that as "references nothing" would delete every blob of a
    // damaged room. A length prefix claiming more bytes than the file holds is
    // the cheapest way to reach that path.
    fs.writeFileSync(path.join(dataDir, 'broken.log'), Buffer.from([0xff, 0xff, 0xff, 0x7f]));
    writeBlob(A, 3 * DAY);

    await expect(collectPersistedBlobRefs(dataDir)).rejects.toThrow(/parsed to nothing/);
    expect(fs.existsSync(path.join(blobsDir, A))).toBe(true);
  });

  it('treats a genuinely empty log as an empty room, not a failure', async () => {
    fs.writeFileSync(path.join(dataDir, 'fresh.log'), Buffer.alloc(0));
    const scan = await collectPersistedBlobRefs(dataDir);
    expect(scan.roomLogs).toBe(1);
    expect(scan.refs.size).toBe(0);
  });

  it('aborts when there are blobs but zero room logs', async () => {
    // What a mispointed dataDir looks like. Without the guard the empty
    // reference set condemns every blob on the volume.
    writeBlob(A, 3 * DAY);
    await expect(
      planBlobGc({ blobsDir, referenced: new Set(), roomLogs: 0, graceMs: DAY }),
    ).rejects.toThrow(/ZERO room logs/);
  });

  it('reclaims stale upload leftovers but not fresh ones', async () => {
    await writeRoom('room-1', []);
    const stale = path.join(blobsDir, `${A}.tmp-old`);
    const fresh = path.join(blobsDir, `${B}.tmp-new`);
    fs.writeFileSync(stale, 'x');
    fs.writeFileSync(fresh, 'x');
    const t = (Date.now() - 3 * DAY) / 1000;
    fs.utimesSync(stale, t, t);

    const p = await plan();
    expect(p.deleteTmpPaths).toEqual([stale]);
  });

  it('missing blobs directory is not a failure', async () => {
    fs.rmSync(blobsDir, { recursive: true });
    const p = await planBlobGc({ blobsDir, referenced: new Set(), roomLogs: 1 });
    expect(p.deleteHashes).toEqual([]);
  });

  it('deleteIfOlderThan refuses a blob whose mtime was refreshed', async () => {
    const storage = new FsBlobStorage(dataDir);
    await storage.put(A, new Uint8Array([9]));
    // Cutoff in the past relative to the just-written file: this is the
    // re-check that makes a plan-then-apply race safe.
    expect(await storage.deleteIfOlderThan(A, Date.now() - 1000)).toBe(false);
    expect(await storage.has(A)).toBe(true);
    // ...and it does delete once the file really is older than the cutoff.
    expect(await storage.deleteIfOlderThan(A, Date.now() + 1000)).toBe(true);
    expect(await storage.has(A)).toBe(false);
  });

  it('a concurrent re-upload survives a delete issued against it', async () => {
    // The real race: GC planned against an OLD blob (so a past cutoff, exactly
    // as the worker computes `now - graceMs`) while a client re-uploads it.
    const storage = new FsBlobStorage(dataDir);
    writeBlob(A, 3 * DAY);
    const cutoff = Date.now() - 1000;

    await Promise.all([
      storage.put(A, new Uint8Array([2])),
      storage.deleteIfOlderThan(A, cutoff),
    ]);

    // Whichever order the per-hash lock grants, the blob must exist afterwards:
    // if the delete ran first the put recreated it; if the put ran first it
    // refreshed mtime and the delete refused. What must never happen is the
    // unlink landing on the just-uploaded file.
    //
    // Honest limit: without the lock this interleaving is timing-dependent, so
    // this test can pass against a broken implementation. It pins the intended
    // contract; `deleteIfOlderThan refuses a blob whose mtime was refreshed`
    // above is the deterministic half.
    expect(await storage.has(A)).toBe(true);
  });

  it('the worker sweeps end to end and reports what it did', async () => {
    await writeRoom('room-1', [A]);
    writeBlob(A, 3 * DAY);
    writeBlob(B, 3 * DAY);

    let sweeps = 0;
    const worker = new BlobGcWorker({
      dataDir,
      storage: new FsBlobStorage(dataDir),
      graceMs: DAY,
      counters: { sweep: () => (sweeps += 1) },
    });
    const result = await worker.runOnce();

    expect(result.deletedBlobs).toBe(1);
    expect(result.roomLogs).toBe(1);
    expect(sweeps).toBe(1);
    expect(fs.existsSync(path.join(blobsDir, A))).toBe(true);
    expect(fs.existsSync(path.join(blobsDir, B))).toBe(false);
  });

  it('keeps a blob that becomes referenced between the scan and the delete', async () => {
    // The sweep collects live references, plans, then re-collects immediately
    // before deleting. This stub reports NO references on the first call and
    // the orphan's hash on every later call, which is exactly a loaded room
    // gaining a reference mid-sweep through an ordinary CRDT update.
    await writeRoom('room-1', [A]);
    writeBlob(A, 3 * DAY);
    writeBlob(B, 3 * DAY);

    const docWithB = new Y.Doc();
    docWithB.transact(() => {
      geometryMap(docWithB).set('g0', new Y.Map<unknown>());
      (geometryMap(docWithB).get('g0') as Y.Map<unknown>).set('blobHash', B);
    });

    let calls = 0;
    const roomManager = {
      list: () => {
        calls += 1;
        return calls === 1 ? [] : ['late'];
      },
      peek: () => Promise.resolve({ doc: docWithB }),
    } as unknown as Parameters<typeof collectLiveBlobRefs>[0];

    const worker = new BlobGcWorker({
      dataDir,
      storage: new FsBlobStorage(dataDir),
      roomManager,
      graceMs: DAY,
    });
    const result = await worker.runOnce();

    expect(result.deletedBlobs).toBe(0);
    expect(fs.existsSync(path.join(blobsDir, B)), 'B was referenced mid-sweep but still deleted').toBe(
      true,
    );
    docWithB.destroy();
  });
});
