/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which element's geometry lands in which zone's file (#2508 item 2).
 *
 * The cutting is the kernel's and is tested in Rust plus across the real wasm
 * boundary. The routing is this module's, and it is where a plausible-looking
 * mistake hides: a per-section model that quietly contains the wrong section's
 * straddler pieces still opens, still looks like a building, and is wrong.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { MeshData } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store/index.js';
import { exportZoneGeometry } from './useZoneGeometrySplit.js';
import type { SplitMeshByZonesFn } from '@/lib/zones/split.js';
import type { ZoneSet } from '@/lib/zones';

const STRADDLER = 10;
const WHOLE = 11;
const UNPROVED = 12;

const ZONE_SET: ZoneSet = {
  id: 'set-1',
  name: 'Takt areas',
  zones: [
    { id: 'z-a', name: 'Takt A', center: [0, 0, 0], size: [10, 10, 10], rotationY: 0 },
    { id: 'z-b', name: 'Takt B', center: [10, 0, 0], size: [10, 10, 10], rotationY: 0 },
  ],
  visible: true,
  createdAt: 0,
  updatedAt: 0,
};

function mesh(expressId: number): MeshData {
  return {
    expressId,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    color: [1, 0, 0, 1],
  } as MeshData;
}

/** A split that puts 1 m3 in each zone, so both zones have a piece and the
 *  routing has something to get wrong. */
const split: SplitMeshByZonesFn = () => ({
  pieceCount: 2,
  wholeVolume: 2,
  sumErrorRel: 0,
  piece(index: number) {
    return {
      zoneIndex: index,
      // A distinct x per zone, so the emitted file can be checked for WHICH
      // piece it received rather than merely that it received one.
      positions: Float64Array.from([index, 0, 0, index + 1, 0, 0, index, 1, 0]),
      indices: Uint32Array.from([0, 1, 2]),
      volume: 1,
      free: () => {},
    };
  },
  free: () => {},
});

function seed() {
  useViewerStore.setState({
    zoneSets: [ZONE_SET],
    zoneAssignments: new Map([
      [STRADDLER, { 'set-1': { zoneId: 'z-a', zoneName: 'Takt A', straddles: true, touchedZoneIds: ['z-a', 'z-b'] } }],
      [WHOLE, { 'set-1': { zoneId: 'z-b', zoneName: 'Takt B', straddles: false, touchedZoneIds: ['z-b'] } }],
      [UNPROVED, { 'set-1': { zoneId: 'z-a', zoneName: 'Takt A', straddles: true, touchedZoneIds: ['z-a'] } }],
    ]) as never,
    // The kernel proved a volume for the first two only. `geometryResult` is
    // the legacy single-model channel `gatherProvedVolumes` reads first.
    geometryResult: {
      meshes: [
        { expressId: STRADDLER, geometryVolume: 2 },
        { expressId: WHOLE, geometryVolume: 5 },
        { expressId: UNPROVED },
      ],
    } as never,
    models: new Map(),
  } as never);
}

function runExport(zoneIndex: number) {
  const emitted: Array<{ bytes: Uint8Array; filename: string }> = [];
  const result = exportZoneGeometry(ZONE_SET, zoneIndex, {
    split,
    meshPieces: (globalId) => [mesh(globalId)],
    emit: (bytes, filename) => emitted.push({ bytes, filename }),
  });
  return { result, emitted };
}

describe('exporting one zone as its own model', () => {
  beforeEach(seed);

  it('writes whole elements and cut pieces, and counts what it refused', () => {
    const { result } = runExport(1);
    assert.ok(result.ok);
    assert.equal(result.summary.whole, 1, 'the element wholly in Takt B');
    assert.equal(result.summary.cut, 1, 'the straddler cut at the boundary');
    assert.equal(result.summary.volumeM3, 6, 'whole 5 m3 plus a 1 m3 piece');
  });

  it('refuses a straddler whose mesh the kernel never proved', () => {
    // Zone A holds the straddler and the unproved element.
    const { result } = runExport(0);
    assert.ok(result.ok);
    assert.equal(result.summary.cut, 1);
    assert.equal(result.summary.refused, 1);
  });

  it('takes the piece belonging to the zone asked for, not the first one', () => {
    // The fake split gives zone i a piece at x = i. If the routing ignored
    // zoneIndex and took pieces[0], the file for Takt B would carry Takt A's
    // geometry: same triangle count, same volume, wrong section.
    const a = runExport(0);
    const b = runExport(1);
    assert.ok(a.result.ok && b.result.ok);
    assert.notEqual(a.emitted[0].bytes.byteLength, 0);
    assert.notDeepEqual(
      [...a.emitted[0].bytes.slice(0, 512)],
      [...b.emitted[0].bytes.slice(0, 512)],
      'both zones produced byte-identical files, so the piece was not selected by zone',
    );
  });

  it('names the file after the set and the zone', () => {
    const { emitted } = runExport(0);
    assert.equal(emitted[0].filename, 'Takt areas-Takt A.glb');
  });

  it('reports rather than emits when no geometry reaches the zone', () => {
    useViewerStore.setState({ zoneAssignments: new Map() } as never);
    const emitted: Uint8Array[] = [];
    const result = exportZoneGeometry(ZONE_SET, 0, {
      split,
      meshPieces: () => null,
      emit: (bytes) => emitted.push(bytes),
    });
    assert.equal(result.ok, false);
    assert.equal(emitted.length, 0, 'an empty zone must not download an empty file');
  });

  it('degrades to a message when the wasm build has no splitter', () => {
    const result = exportZoneGeometry(ZONE_SET, 0, {
      split: undefined,
      meshPieces: (globalId) => [mesh(globalId)],
      emit: () => {},
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'no-binding');
  });
});
