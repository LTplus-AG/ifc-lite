/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, expect, it } from 'vitest';
import type { MeshData } from './types.js';
import { acceptRecordFrame, attachGpuRecords, bindRecordFrameCell, createRecordFrameCell, readRecordFrame, relayRecordFrame } from './gpu-record-frame.js';
import { encodeMeshRecords } from './gpu-records.js';

function box(id: number, x: number): MeshData {
  const positions = new Float32Array([x, 0, 0, x + 1, 0, 0, x, 1, 0, x, 0, 1]);
  return { expressId: id, modelIndex: 0, color: [0.4, 0.5, 0.6, 1], positions,
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2, 0, 2, 3]) } as MeshData;
}

describe('GPU records from the geometry workers (M2)', () => {
  it('the pool posts the renderer\'s frame to every worker once it has one, and only once', () => {
    let frame: { frame: [number, number, number]; cellSize: number } | null = null;
    const posted: unknown[][] = [[], []];
    const workers = posted.map((inbox) => ({ postMessage: (message: unknown) => inbox.push(message) })) as unknown as Worker[];
    const relay = relayRecordFrame(() => frame);
    relay.offer(workers);
    expect(posted.map((inbox) => inbox.length)).toEqual([0, 0]);
    frame = { frame: [1, 2, 3], cellSize: 32 };
    relay.offer(workers);
    relay.offer(workers);
    expect(posted).toEqual([[{ type: 'record-frame', frame: [1, 2, 3], cellSize: 32 }], [{ type: 'record-frame', frame: [1, 2, 3], cellSize: 32 }]]);
    relayRecordFrame(undefined).offer(workers); // no source: nothing is ever sent
    expect(posted[0]).toHaveLength(1);
  });

  it('a worker encodes each mesh against its session\'s frame and its own lattice origin, and transfers the records', () => {
    const session = {};
    const before = box(1, 0.5);
    const transfers: ArrayBuffer[] = [];
    attachGpuRecords(session, before, transfers);
    expect(before.gpuRecords).toBeUndefined(); // no frame yet: the main thread merges it
    expect(acceptRecordFrame(session, { type: 'set-styles' })).toBe(false);
    expect(acceptRecordFrame(session, { type: 'record-frame', frame: [0.25, 0, 0], cellSize: 32 })).toBe(true);
    const after = box(2, 0.5);
    attachGpuRecords(session, after, transfers);
    const expected = encodeMeshRecords(after, [0.25, 0, 0])!;
    expect(after.gpuRecords?.pin).toEqual(expected.pin);
    expect(expected.pin.every((v) => Number.isInteger(v * 1024))).toBe(true); // on the 2^-10 lattice
    expect(new Uint8Array(after.gpuRecords!.records)).toEqual(new Uint8Array(expected.records));
    expect(transfers).toEqual([after.gpuRecords!.records]);
    const other = box(3, 0.5);
    attachGpuRecords({}, other, transfers); // another session (a new load) has no frame
    expect(other.gpuRecords).toBeUndefined();
    expect(acceptRecordFrame(session, { type: 'record-frame', frame: [NaN, 0, 0], cellSize: 32 })).toBe(true); // ignored, not adopted
    expect(acceptRecordFrame(null, { type: 'record-frame', frame: [0, 0, 0], cellSize: 32 })).toBe(true); // before any session: ignored
  });
});

describe('the frame through the shared cell (M2, no worker event loop needed)', () => {
  it('the pool publishes the ready word last; nothing is readable before', () => {
    let known: { frame: [number, number, number]; cellSize: number } | null = null;
    const relay = relayRecordFrame(() => known);
    expect(relay.cell).toBeInstanceOf(SharedArrayBuffer);
    expect(readRecordFrame(relay.cell!)).toBeNull();
    relay.offer([]);
    expect(readRecordFrame(relay.cell!)).toBeNull(); // not ready yet: nothing published
    known = { frame: [0.5, -2, 3.25], cellSize: 32 };
    relay.offer([]);
    expect(readRecordFrame(relay.cell!)).toEqual({ frame: [0.5, -2, 3.25], cellSize: 32 });
    expect(relayRecordFrame(undefined).cell).toBeNull(); // no frame source: no cell
  });

  it('a worker inside a slice picks the frame up at its next mesh, with no message; earlier meshes keep the old path', () => {
    const relay = relayRecordFrame(() => ({ frame: [0.25, 0, 0], cellSize: 32 }), createRecordFrameCell());
    const session = {};
    bindRecordFrameCell(session, relay.cell);
    const before = box(10, 0.5);
    attachGpuRecords(session, before, []);
    expect(before.gpuRecords).toBeUndefined(); // collected before publication: main-thread merge
    relay.offer([]); // publish (the record-frame message is never delivered to this worker)
    const after = box(11, 0.5);
    attachGpuRecords(session, after, []);
    expect(new Uint8Array(after.gpuRecords!.records)).toEqual(new Uint8Array(encodeMeshRecords(after, [0.25, 0, 0])!.records));
  });

  it('without a shared cell the record-frame message alone gives the same records', () => {
    const viaCell = {}, viaMessage = {};
    const relay = relayRecordFrame(() => ({ frame: [0.25, 0, 0], cellSize: 32 }), createRecordFrameCell());
    bindRecordFrameCell(viaCell, relay.cell);
    const posted: unknown[] = [];
    relay.offer([{ postMessage: (m: unknown) => posted.push(m) } as unknown as Worker]);
    bindRecordFrameCell(viaMessage, null); // a host without SharedArrayBuffer
    expect(acceptRecordFrame(viaMessage, posted[0])).toBe(true);
    const a = box(12, 0.5), b = box(12, 0.5);
    attachGpuRecords(viaCell, a, []);
    attachGpuRecords(viaMessage, b, []);
    expect(new Uint8Array(b.gpuRecords!.records)).toEqual(new Uint8Array(a.gpuRecords!.records));
  });
});
