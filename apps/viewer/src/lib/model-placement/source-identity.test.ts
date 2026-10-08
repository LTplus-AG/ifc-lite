/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { Blob, File } from 'node:buffer';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { perfCounters } from '@ifc-lite/load-trace';
import { computeSourceFingerprint } from '@ifc-lite/cache';
import { placementSourceIdentity } from './source-identity';
import { saveWorkspacePlacements, restoreWorkspacePlacements } from './persistence';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { emptyPlacementState, importPlacements } from './state';

it('does not restore a placement onto a same-name same-length gap edit (#4226)', async () => {
  const a = new Uint8Array(4_000_000), b = a.slice(); b[700_000] = 1;
  assert.equal(computeSourceFingerprint(a).hex, computeSourceFingerprint(b).hex);
  const original = new File([a], 'scan.xyz'), revised = new File([b], 'scan.xyz');
  const hashA = await placementSourceIdentity(original), hashB = await placementSourceIdentity(revised);
  assert.ok(hashA); assert.ok(hashB); assert.notEqual(hashA, hashB);
  assert.equal(await placementSourceIdentity(new File([a], 'renamed.xyz')), hashA);
  const makeState = (hash: string) => ({ ...useViewerStore.getState(),
    ...fixtureModels({ ...fixtureModel('m'), sourceContentHash: hash }), modelPlacement: emptyPlacementState() });
  const state = makeState(hashA), values = new Map<string, string>();
  const disk = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  state.modelPlacement = importPlacements(state.modelPlacement, new Map([['m', { translation: [42, 0, 0], locked: false }]]));
  saveWorkspacePlacements(disk, state);
  assert.equal(restoreWorkspacePlacements(disk, makeState(hashB)).size, 0);
  assert.deepEqual(restoreWorkspacePlacements(disk, makeState(hashA)).get('m')?.translation, [42, 0, 0]);
});

it('reads every scan byte in bounded chunks and never reads the whole Blob (#4226)', async () => {
  let readBytes = 0, largestRead = 0;
  class Scan extends Blob {
    override async arrayBuffer(): Promise<ArrayBuffer> { throw new Error('Whole scan allocation'); }
    override slice(start?: number, end?: number, type?: string): Blob {
      const chunk = super.slice(start, end, type);
      readBytes += chunk.size; largestRead = Math.max(largestRead, chunk.size);
      return chunk;
    }
  }
  const scan = new Scan([new Uint8Array(3_000_123)]);
  assert.ok(await placementSourceIdentity(scan));
  assert.equal(readBytes, scan.size); assert.ok(largestRead <= 1024 * 1024);
});

it('stops the full-file pass at the next chunk after cancellation (#4226)', async () => {
  let reads = 0, cancelled = false;
  const source = { size: 3 * 1024 * 1024, slice() { reads++; return { async arrayBuffer() {
    cancelled = true; return new ArrayBuffer(1024 * 1024);
  } }; } };
  assert.equal(await placementSourceIdentity(source, () => cancelled), undefined);
  assert.equal(reads, 1, 'cancelling a scan does not drain the rest of its bytes');
  assert.ok(await placementSourceIdentity(source), 'a cancelled request is not cached as the file identity');
});

// #6431: the IFC loader already holds the file in memory; re-reading it through
// a thousand Blob slices cost seconds on a 1 GB file before parsing started.
it('hashes bytes already in memory to the same identity, without reading the Blob (#6431)', async () => {
  const bytes = new Uint8Array(2 * 1024 * 1024 + 123);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) & 0xff;
  const expected = await placementSourceIdentity(new File([bytes], 'model.ifc'));
  assert.ok(expected);
  let blobReads = 0;
  class Unread extends Blob {
    override slice(): Blob { blobReads++; throw new Error('the Blob must not be re-read'); }
  }
  assert.equal(await placementSourceIdentity(new Unread([bytes]), () => false, bytes), expected);
  const shared = new Uint8Array(new SharedArrayBuffer(bytes.byteLength));
  shared.set(bytes);
  assert.equal(await placementSourceIdentity(new Unread([bytes]), () => false, shared), expected,
    'a SharedArrayBuffer-backed view hashes the same bytes');
  assert.equal(blobReads, 0);
});

it('falls back to the Blob when the in-memory bytes are not the whole source (#6431)', async () => {
  const bytes = new Uint8Array(1_500_000).fill(7);
  const source = new File([bytes], 'model.ifc');
  const expected = await placementSourceIdentity(new File([bytes], 'copy.ifc'));
  assert.equal(await placementSourceIdentity(source, () => false, bytes.subarray(0, 1000)), expected);
});

// #7022: the identity is the load's one full-source hash (placement, cache
// write and warm revalidation all use it), so its value must not move and its
// in-memory pass must not copy the source on the main thread.
const MIB = 1024 * 1024;
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
function referenceIdentity(bytes: Uint8Array): string {
  const parts = [`placement-sha256-1m-v1:${bytes.byteLength}`];
  for (let start = 0; start < bytes.byteLength; start += MIB) parts.push(sha256(bytes.subarray(start, start + MIB)));
  return `placement-sha256-1m-v1:${sha256(parts.join(':'))}`;
}

it('keeps the identity value for every reader: Blob, in-memory and shared bytes (#7022)', async () => {
  const bytes = new Uint8Array(9 * MIB + 4321);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 131 + (i >> 11)) & 0xff;
  const expected = referenceIdentity(bytes);
  assert.equal(await placementSourceIdentity(new File([bytes], 'blob.ifc')), expected);
  assert.equal(await placementSourceIdentity(new File([bytes], 'memory.ifc'), () => false, bytes), expected);
  const shared = new Uint8Array(new SharedArrayBuffer(bytes.byteLength));
  shared.set(bytes);
  assert.equal(await placementSourceIdentity(new File([bytes], 'shared.ifc'), () => false, shared), expected);
});

it('digests in-memory chunks in place and counts one full-source pass (#7022)', async () => {
  const bytes = new Uint8Array(3 * MIB + 5000).fill(5);
  const subtle = globalThis.crypto.subtle;
  const realDigest = subtle.digest.bind(subtle);
  const inputs: BufferSource[] = [];
  Object.defineProperty(subtle, 'digest', { configurable: true, writable: true,
    value: (algorithm: AlgorithmIdentifier, data: BufferSource) => { inputs.push(data); return realDigest(algorithm, data); } });
  perfCounters.enable();
  const before = perfCounters.read();
  try {
    assert.equal(await placementSourceIdentity(new File([bytes], 'model.ifc'), () => false, bytes), referenceIdentity(bytes));
  } finally {
    delete (subtle as { digest?: unknown }).digest;
  }
  const chunkInputs = inputs.filter((data) => data.byteLength >= 4096);
  assert.equal(chunkInputs.length, 4);
  assert.ok(chunkInputs.every((data) => ArrayBuffer.isView(data) && data.buffer === bytes.buffer),
    'each chunk is a view of the bytes the loader holds, not a main-thread copy');
  const after = perfCounters.read();
  assert.equal((after['hash.fullSource.count'] ?? 0) - (before['hash.fullSource.count'] ?? 0), 1);
  assert.equal((after['hash.fullSource.bytes'] ?? 0) - (before['hash.fullSource.bytes'] ?? 0), bytes.byteLength);
});
