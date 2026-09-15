/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { CoordinateHandler, NORMAL_COORD_THRESHOLD_M } from './coordinate-handler.js';
import type { MeshData } from './types.js';

function mesh(expressId: number, positions: number[]): MeshData {
  return {
    expressId,
    ifcType: 'IfcWall',
    positions: new Float32Array(positions),
    normals: new Float32Array(),
    indices: new Uint32Array(),
    color: [1, 1, 1, 1],
  };
}

describe('CoordinateHandler authoritative WASM RTC state (#4799)', () => {
  it('records and defensively copies an exact known-false frame', () => {
    const handler = new CoordinateHandler();
    const frame = { x: 123, y: -456, z: 789, needsShift: false };

    handler.setWasmMetadata(1, null, frame);
    frame.x = 999;

    const first = handler.getFinalCoordinateInfo();
    expect(first.wasmRtcFrame).toEqual({ x: 123, y: -456, z: 789, needsShift: false });
    expect(first.wasmRtcOffset).toBeUndefined();
    if (first.wasmRtcFrame) first.wasmRtcFrame.y = 999;
    expect(handler.getFinalCoordinateInfo().wasmRtcFrame).toEqual({
      x: 123,
      y: -456,
      z: 789,
      needsShift: false,
    });
  });

  it('maps legacy two-argument metadata to deterministic exact provenance', () => {
    const handler = new CoordinateHandler();
    handler.setWasmMetadata(1, { x: 1, y: 2, z: 3 });

    expect(handler.getFinalCoordinateInfo().wasmRtcOffset).toEqual({ x: 1, y: 2, z: 3 });
    expect(handler.getFinalCoordinateInfo().wasmRtcFrame).toEqual({
      x: 1,
      y: 2,
      z: 3,
      needsShift: true,
    });

    handler.setWasmMetadata(1, null);
    expect(handler.getFinalCoordinateInfo().wasmRtcFrame).toEqual({
      x: 0,
      y: 0,
      z: 0,
      needsShift: false,
    });
  });

  it.each([
    { x: Number.NaN, y: 2, z: 3 },
    { x: 1, y: Number.POSITIVE_INFINITY, z: 3 },
    { x: 1, y: 2, z: Number.NEGATIVE_INFINITY },
  ])('keeps legacy non-finite offsets non-throwing but clears exact provenance: %o', (offset) => {
    const handler = new CoordinateHandler();
    handler.setWasmMetadata(1, { x: 1, y: 2, z: 3 });

    expect(() => handler.setWasmMetadata(2, offset)).not.toThrow();

    const info = handler.getFinalCoordinateInfo();
    expect(info.wasmRtcOffset).toEqual(offset);
    expect(info.wasmRtcFrame).toBeUndefined();
    expect(info.lengthUnitScale).toBe(2);
  });

  it('rejects malformed exact provenance before mutating existing state', () => {
    const handler = new CoordinateHandler();
    handler.setWasmMetadata(
      1,
      { x: 1, y: 2, z: 3 },
      { x: 1, y: 2, z: 3, needsShift: true },
    );
    const before = handler.getFinalCoordinateInfo();

    expect(() => handler.setWasmMetadata(
      2,
      { x: 1, y: 2, z: 3 },
      { x: 1, y: 2, z: 4, needsShift: true },
    )).toThrow('Exact WASM RTC frame disagrees');
    expect(() => handler.setWasmMetadata(
      2,
      null,
      { x: Number.NaN, y: 0, z: 0, needsShift: false },
    )).toThrow('finite coordinates');
    expect(() => handler.setWasmMetadata(
      2,
      null,
      { x: 0, y: 0, z: 0, needsShift: true },
    )).toThrow('Exact WASM RTC frame disagrees');
    expect(() => handler.setWasmMetadata(
      2,
      { x: 0, y: Number.POSITIVE_INFINITY, z: 0 },
      { x: 0, y: Number.POSITIVE_INFINITY, z: 0, needsShift: true },
    )).toThrow('when exact provenance is supplied');
    expect(handler.getFinalCoordinateInfo()).toEqual(before);
  });

  it('keeps a known applied zero offset authoritative against an opposing vote', () => {
    const handler = new CoordinateHandler();
    const batch = [mesh(1, [500000, 5000000, 0, 500010, 5000010, 5])];
    handler.setWasmMetadata(1, { x: 0, y: 0, z: 0 });

    handler.processMeshesIncremental(batch);

    const info = handler.getFinalCoordinateInfo();
    expect(info.originShift).toEqual({ x: 0, y: 0, z: 0 });
    expect(info.originalBounds).toEqual({
      min: { x: 0, y: 0, z: 0 },
      max: { x: 0, y: 0, z: 0 },
    });
    expect(info.wasmRtcOffset).toEqual({ x: 0, y: 0, z: 0 });
    expect(info.lengthUnitScale).toBe(1);
    expect(Array.from(batch[0].positions)).toEqual([500000, 5000000, 0, 500010, 5000010, 5]);
  });

  it('keeps known-not-applied authoritative against a small-mesh majority', () => {
    const handler = new CoordinateHandler();
    const batch = [
      mesh(1, [0, 0, 0, 1, 1, 1]),
      mesh(2, [2, 2, 2, 3, 3, 3]),
      mesh(3, [500000, 5000000, 0, 500010, 5000010, 5]),
    ];
    handler.setWasmMetadata(0.001, null);

    handler.processMeshesIncremental(batch);

    const info = handler.getFinalCoordinateInfo();
    expect(info.originShift).toEqual({ x: 250005, y: 2500005, z: 2.5 });
    expect(info.originalBounds.max).toEqual({ x: 500010, y: 5000010, z: 5 });
    expect(info.shiftedBounds.min.x).toBe(-250005);
    expect(info.wasmRtcOffset).toBeUndefined();
    expect(info.lengthUnitScale).toBe(0.001);
    expect(batch[0].positions[0]).toBe(-250005);
  });

  it('retains sampled later-batch bounds for validated near-origin known-false WASM', () => {
    const handler = new CoordinateHandler();
    handler.setWasmMetadata(1, null);
    handler.processMeshesIncremental([mesh(1, [0, 0, 0, 1, 1, 1])]);
    handler.processMeshesIncremental([mesh(2, [2, 0, 0, 900, 0, 0, 4, 0, 0])]);

    const info = handler.getFinalCoordinateInfo();
    expect(info.originShift).toEqual({ x: 0, y: 0, z: 0 });
    expect(info.originalBounds.max.x).toBe(4);
    expect(info.lengthUnitScale).toBe(1);
  });

  it('does not sample known-false bounds when a zero-centroid model spans the threshold', () => {
    const handler = new CoordinateHandler();
    const threshold = NORMAL_COORD_THRESHOLD_M;
    handler.setWasmMetadata(1, null);
    handler.processMeshesIncremental([mesh(1, [-2 * threshold, 0, 0, 2 * threshold, 0, 0])]);
    handler.processMeshesIncremental([mesh(2, [2, 0, 0, 3 * threshold, 0, 0, 4, 0, 0])]);

    const info = handler.getFinalCoordinateInfo();
    expect(info.originShift).toEqual({ x: 0, y: 0, z: 0 });
    expect(info.originalBounds.max.x).toBe(3 * threshold);
  });

  it('does not sample known-false bounds unless every component is inside the threshold', () => {
    const handler = new CoordinateHandler();
    const threshold = NORMAL_COORD_THRESHOLD_M;
    handler.setWasmMetadata(1, null);
    handler.processMeshesIncremental([mesh(1, [1.1 * threshold, 0, 0, 0.2 * threshold, 0, 0])]);
    handler.processMeshesIncremental([mesh(2, [2, 0, 0, 3 * threshold, 0, 0, 4, 0, 0])]);

    const info = handler.getFinalCoordinateInfo();
    expect(info.originShift).toEqual({ x: 0, y: 0, z: 0 });
    expect(info.originalBounds.max.x).toBe(3 * threshold);
  });

  it('waits through empty and unusable batches before making the first decision', () => {
    const handler = new CoordinateHandler();
    handler.setWasmMetadata(1, null);
    handler.processMeshesIncremental([]);
    handler.processMeshesIncremental([mesh(1, [Number.NaN, 0, 0])]);
    expect(handler.getCurrentCoordinateInfo()).toBeNull();

    const valid = mesh(2, [20000, 0, 0, 20010, 10, 10]);
    handler.processMeshesIncremental([valid]);

    const info = handler.getFinalCoordinateInfo();
    expect(info.originShift).toEqual({ x: 20005, y: 5, z: 5 });
    expect(info.originalBounds.max.x).toBe(20010);
    expect(valid.positions[0]).toBe(-5);
  });

  it('reset clears authority and sampling before a differently framed model', () => {
    const handler = new CoordinateHandler();
    handler.setWasmMetadata(1, { x: 0, y: 0, z: 0 });
    handler.processMeshesIncremental([mesh(1, [0, 0, 0, 1, 1, 1])]);
    expect(handler.getFinalCoordinateInfo().wasmRtcOffset).toEqual({ x: 0, y: 0, z: 0 });

    handler.reset();
    const nativeBatch = mesh(2, [20000, 0, 0, 20010, 10, 10]);
    handler.processMeshesIncremental([nativeBatch]);

    const info = handler.getFinalCoordinateInfo();
    expect(info.originShift).toEqual({ x: 20005, y: 5, z: 5 });
    expect(info.wasmRtcOffset).toBeUndefined();
    expect(info.wasmRtcFrame).toBeUndefined();
    expect(info.lengthUnitScale).toBeUndefined();
    expect(nativeBatch.positions[0]).toBe(-5);
  });
});
