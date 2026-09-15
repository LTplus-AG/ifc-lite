/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import { BufferReader, BufferWriter } from '../utils/buffer-utils.js';
import { readCoordinateInfo, writeCoordinateInfo } from './coordinate-info.js';

const baseInfo = (): CoordinateInfo => ({
  originShift: { x: 1, y: 2, z: 3 },
  originalBounds: { min: { x: -1, y: -2, z: -3 }, max: { x: 4, y: 5, z: 6 } },
  shiftedBounds: { min: { x: -2, y: -3, z: -4 }, max: { x: 3, y: 4, z: 5 } },
  hasLargeCoordinates: true,
});

function encode(info: CoordinateInfo): ArrayBuffer {
  const writer = new BufferWriter(128);
  writeCoordinateInfo(writer, info);
  return writer.build();
}

describe('v20 exact WASM RTC frame metadata (#4799)', () => {
  it.each([
    { wasmRtcFrame: undefined, wasmRtcOffset: undefined },
    { wasmRtcFrame: { x: 100, y: 200, z: 300, needsShift: false }, wasmRtcOffset: undefined },
    {
      wasmRtcFrame: { x: 100, y: 200, z: 300, needsShift: true },
      wasmRtcOffset: { x: 100, y: 200, z: 300 },
    },
    {
      wasmRtcFrame: { x: 0, y: 0, z: 0, needsShift: true },
      wasmRtcOffset: { x: 0, y: 0, z: 0 },
    },
  ])('round-trips absent, false, true, and active-zero frames: %o', ({ wasmRtcFrame, wasmRtcOffset }) => {
    const info: CoordinateInfo = { ...baseInfo(), wasmRtcFrame, wasmRtcOffset };
    expect(readCoordinateInfo(new BufferReader(encode(info)), 20)).toEqual(info);
  });

  it('preserves signed zero in every frame component', () => {
    const info: CoordinateInfo = {
      ...baseInfo(),
      wasmRtcFrame: { x: -0, y: 0, z: -0, needsShift: false },
    };
    const frame = readCoordinateInfo(new BufferReader(encode(info)), 20).wasmRtcFrame;
    expect(frame).toBeDefined();
    expect(Object.is(frame?.x, -0)).toBe(true);
    expect(Object.is(frame?.y, 0)).toBe(true);
    expect(Object.is(frame?.z, -0)).toBe(true);
  });

  it.each([
    { x: Number.NaN, y: 2, z: 3 },
    { x: 1, y: Number.POSITIVE_INFINITY, z: 3 },
    { x: 1, y: 2, z: Number.NEGATIVE_INFINITY },
  ])('preserves legacy frame-absent v20 offsets verbatim: %o', (wasmRtcOffset) => {
    const info: CoordinateInfo = { ...baseInfo(), wasmRtcOffset };
    expect(readCoordinateInfo(new BufferReader(encode(info)), 20)).toEqual(info);
  });

  it('reads the v13-v19 layout without manufacturing frame provenance', () => {
    const current = new Uint8Array(encode(baseInfo()));
    const legacy = current.slice(0, -1).buffer;

    for (const version of [13, 14, 15, 16, 17, 18, 19]) {
      expect(readCoordinateInfo(new BufferReader(legacy), version).wasmRtcFrame).toBeUndefined();
    }
  });

  it('rejects invalid flags and truncated exact frames', () => {
    const absent = new Uint8Array(encode(baseInfo()));
    absent[absent.length - 1] = 2;
    expect(() => readCoordinateInfo(new BufferReader(absent.buffer), 20)).toThrow(
      'Invalid wasmRtcFrame presence flag',
    );

    const complete = new Uint8Array(encode({
      ...baseInfo(),
      wasmRtcOffset: { x: 1, y: 2, z: 3 },
      wasmRtcFrame: { x: 1, y: 2, z: 3, needsShift: true },
    }));
    const needsShiftIndex = complete.length - 1;
    complete[needsShiftIndex] = 2;
    expect(() => readCoordinateInfo(new BufferReader(complete.buffer), 20)).toThrow(
      'Invalid wasmRtcFrame needsShift flag',
    );
    expect(() => readCoordinateInfo(
      new BufferReader(complete.slice(0, needsShiftIndex).buffer),
      20,
    )).toThrow(/past end/);
  });

  it('rejects non-finite frame bytes before publishing corrupt provenance', () => {
    const bytes = new Uint8Array(encode({
      ...baseInfo(),
      wasmRtcOffset: { x: 1, y: 2, z: 3 },
      wasmRtcFrame: { x: 1, y: 2, z: 3, needsShift: true },
    }));
    new DataView(bytes.buffer).setFloat64(bytes.length - 25, Number.NaN, true);
    expect(() => readCoordinateInfo(new BufferReader(bytes.buffer), 20)).toThrow(
      'every component must be finite',
    );
  });

  it('rejects malformed or inconsistent frames on write', () => {
    expect(() => encode({
      ...baseInfo(),
      wasmRtcFrame: { x: Number.POSITIVE_INFINITY, y: 2, z: 3, needsShift: false },
    })).toThrow('every component must be finite');
    expect(() => encode({
      ...baseInfo(),
      wasmRtcFrame: { x: 1, y: 2, z: 3, needsShift: 1 as unknown as boolean },
    })).toThrow('needsShift must be a boolean');
    expect(() => encode({
      ...baseInfo(),
      wasmRtcOffset: { x: 1, y: 2, z: 3 },
      wasmRtcFrame: { x: 1, y: 2, z: 3, needsShift: false },
    })).toThrow('needsShift disagrees');
    expect(() => encode({
      ...baseInfo(),
      wasmRtcOffset: { x: 1, y: 2, z: 4 },
      wasmRtcFrame: { x: 1, y: 2, z: 3, needsShift: true },
    })).toThrow('active components disagree');
  });

  it('rejects finite but inconsistent cached provenance on read', () => {
    const bytes = new Uint8Array(encode({
      ...baseInfo(),
      wasmRtcOffset: { x: 1, y: 2, z: 3 },
      wasmRtcFrame: { x: 1, y: 2, z: 3, needsShift: true },
    }));
    new DataView(bytes.buffer).setFloat64(bytes.length - 9, 4, true);
    expect(() => readCoordinateInfo(new BufferReader(bytes.buffer), 20)).toThrow(
      'active components disagree',
    );
  });

  it('rejects a non-finite RTC offset when exact provenance exists', () => {
    const bytes = new Uint8Array(encode({
      ...baseInfo(),
      wasmRtcOffset: { x: 1, y: 2, z: 3 },
      wasmRtcFrame: { x: 1, y: 2, z: 3, needsShift: true },
    }));
    // 3 vec3 blocks (origin + two AABBs) and two one-byte flags precede it.
    new DataView(bytes.buffer).setFloat64(122, Number.POSITIVE_INFINITY, true);
    expect(() => readCoordinateInfo(new BufferReader(bytes.buffer), 20)).toThrow(
      'wasmRtcOffset: every component must be finite',
    );
  });
});
