/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BlobByteSource } from '../streaming/blob-source.js';
import {
  COPC_PROBE_BYTES,
  copcNodeBounds,
  isCopcHeader,
  parseCopcInfo,
  readCopcFileInfo,
  type CopcInfo,
} from './copc-info.js';
import { copcChildKeys } from './copc-hierarchy.js';

const fixtureUrl = new URL('../../test-fixtures/', import.meta.url);
const bytes = new Uint8Array(readFileSync(fileURLToPath(new URL('tiny.copc.laz', fixtureUrl))));
const expected = JSON.parse(readFileSync(fileURLToPath(new URL('tiny-copc.json', fixtureUrl)), 'utf8')) as {
  pointCount: number;
  pdrf: number;
  center: number[];
  halfsize: number;
  spacing: number;
  rootHierOffset: number;
  rootHierSize: number;
  gpsTimeRange: [number, number];
};

describe('COPC header + info VLR (#6869)', () => {
  it('reads the info VLR the generator wrote', async () => {
    const file = await readCopcFileInfo(new BlobByteSource(new Blob([bytes])));
    expect(file.header.pointDataFormatId).toBe(expected.pdrf);
    expect(file.header.pointCount).toBe(expected.pointCount);
    expect(file.info).toEqual({
      center: expected.center,
      halfsize: expected.halfsize,
      spacing: expected.spacing,
      rootHierOffset: expected.rootHierOffset,
      rootHierSize: expected.rootHierSize,
      gpsTimeMin: expected.gpsTimeRange[0],
      gpsTimeMax: expected.gpsTimeRange[1],
    });
  });

  it('detects COPC by the first VLR, not by the file name', () => {
    expect(isCopcHeader(bytes.subarray(0, COPC_PROBE_BYTES))).toBe(true);
    const renamedVlr = bytes.slice(0, COPC_PROBE_BYTES);
    renamedVlr.set(new TextEncoder().encode('laszip'), 375 + 2); // first VLR is no longer copc/1
    expect(isCopcHeader(renamedVlr)).toBe(false);
    const las12 = bytes.slice(0, COPC_PROBE_BYTES);
    las12[25] = 2;
    expect(isCopcHeader(las12)).toBe(false);
    expect(isCopcHeader(bytes.subarray(0, 300))).toBe(false);
  });

  it('rejects a plain LAS file with a clear message', async () => {
    const notCopc = bytes.slice();
    notCopc.set(new TextEncoder().encode('nope'), 375 + 2);
    await expect(readCopcFileInfo(new BlobByteSource(new Blob([notCopc])))).rejects.toThrow(/not a COPC file/);
  });

  it.each([
    ['a zero halfsize', 24, 0, /halfsize/],
    ['a NaN centre', 0, Number.NaN, /centre/],
    ['a negative spacing', 32, -1, /spacing/],
  ])('rejects %s', (_label, at, value, message) => {
    const payload = bytes.slice(375 + 54, COPC_PROBE_BYTES);
    new DataView(payload.buffer).setFloat64(at, value, true);
    expect(() => parseCopcInfo(payload, bytes.length)).toThrow(message);
  });

  it('rejects a root page outside the file or with a ragged size', () => {
    const payload = bytes.slice(375 + 54, COPC_PROBE_BYTES);
    const view = new DataView(payload.buffer);
    view.setUint32(48, 33, true);
    expect(() => parseCopcInfo(payload, bytes.length)).toThrow(/multiple of 32/);
    view.setUint32(48, 64, true);
    view.setUint32(40, bytes.length - 32, true);
    expect(() => parseCopcInfo(payload, bytes.length)).toThrow(/outside/);
  });
});

describe('copcNodeBounds', () => {
  const info: CopcInfo = {
    center: [100, 200, 300], halfsize: 8, spacing: 1, rootHierOffset: 0, rootHierSize: 32, gpsTimeMin: 0, gpsTimeMax: 0,
  };

  it('the root is the info cube', () => {
    expect(copcNodeBounds(info, { d: 0, x: 0, y: 0, z: 0 })).toEqual({ min: [92, 192, 292], max: [108, 208, 308] });
  });

  it('the 8 children tile their parent exactly (no gap, no overlap)', () => {
    const parentKey = { d: 2, x: 1, y: 3, z: 2 };
    const parent = copcNodeBounds(info, parentKey);
    let volume = 0;
    for (const child of copcChildKeys(parentKey)) {
      const b = copcNodeBounds(info, child);
      volume += (b.max[0] - b.min[0]) * (b.max[1] - b.min[1]) * (b.max[2] - b.min[2]);
      for (let a = 0; a < 3; a++) {
        expect(b.min[a]).toBeGreaterThanOrEqual(parent.min[a]);
        expect(b.max[a]).toBeLessThanOrEqual(parent.max[a]);
      }
    }
    const pv = (parent.max[0] - parent.min[0]) ** 3;
    expect(volume).toBeCloseTo(pv, 9);
  });
});
