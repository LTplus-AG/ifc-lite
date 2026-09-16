/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The shared render frame -> IFC world conversion (#4879). Every BCF
 * producer (viewer, CLI, MCP playground, SDK) adds this offset to a Z-up
 * render-frame position, so it has to fold BOTH recorded shifts in, each in
 * its own axes.
 */

import { describe, expect, it } from 'vitest';
import type { CoordinateInfo } from './coordinate-types.js';
import {
  federationFrameInfo,
  ifcToViewerAxes,
  renderFrameWorldOffset,
  totalYupOffset,
  viewerToIfcAxes,
} from './world-frame.js';

/** The #4806 reporter's site, as the wasm pre-pass reports it (IFC Z-up). */
const RTC_IFC = { x: 41266.679, y: 308208.972, z: 125.95 };
/** A further CoordinateHandler shift, recorded in Y-up mesh axes. */
const SHIFT_YUP = { x: 1800, y: -35, z: -2600 };

function info(partial: Partial<CoordinateInfo>): CoordinateInfo {
  const box = { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
  return {
    originShift: { x: 0, y: 0, z: 0 },
    originalBounds: box,
    shiftedBounds: box,
    hasLargeCoordinates: false,
    ...partial,
  };
}

describe('renderFrameWorldOffset', () => {
  it('adds the RTC offset as-is and the Y-up origin shift converted to Z-up', () => {
    const offset = renderFrameWorldOffset(info({ originShift: SHIFT_YUP, wasmRtcOffset: RTC_IFC }));
    // Y-up (x, y, z) is IFC (x, -z, y): the shift's -2600 "towards the viewer"
    // is +2600 north, and its -35 "up" is -35 height.
    expect(offset.x).toBeCloseTo(RTC_IFC.x + 1800, 9);
    expect(offset.y).toBeCloseTo(RTC_IFC.y + 2600, 9);
    expect(offset.z).toBeCloseTo(RTC_IFC.z - 35, 9);
  });

  it('maps a render-frame point to its world position', () => {
    const frame = info({ originShift: SHIFT_YUP, wasmRtcOffset: RTC_IFC });
    // World point, into the render frame the way the mesher does it:
    // subtract the RTC offset in IFC axes, swap to Y-up, subtract the shift.
    const world = { x: RTC_IFC.x + 1812, y: RTC_IFC.y + 2590, z: RTC_IFC.z - 30 };
    const yup = ifcToViewerAxes({ x: world.x - RTC_IFC.x, y: world.y - RTC_IFC.y, z: world.z - RTC_IFC.z });
    const render = viewerToIfcAxes({ x: yup.x - SHIFT_YUP.x, y: yup.y - SHIFT_YUP.y, z: yup.z - SHIFT_YUP.z });
    const offset = renderFrameWorldOffset(frame);
    expect(render.x + offset.x).toBeCloseTo(world.x, 6);
    expect(render.y + offset.y).toBeCloseTo(world.y, 6);
    expect(render.z + offset.z).toBeCloseTo(world.z, 6);
  });

  it('is exactly zero, with no negative zero, for an unshifted or unknown frame', () => {
    for (const frame of [undefined, null, info({}), { originShift: null, wasmRtcOffset: null }]) {
      const offset = renderFrameWorldOffset(frame);
      expect(Object.is(offset.x, 0) && Object.is(offset.y, 0) && Object.is(offset.z, 0)).toBe(true);
    }
  });

  it('agrees with totalYupOffset, the viewer-axes form', () => {
    const frame = info({ originShift: SHIFT_YUP, wasmRtcOffset: RTC_IFC });
    expect(renderFrameWorldOffset(frame)).toEqual(viewerToIfcAxes(totalYupOffset(frame)));
  });
});

describe('federationFrameInfo', () => {
  const anchor = info({ wasmRtcOffset: RTC_IFC });
  const later = info({ wasmRtcOffset: { x: 1, y: 2, z: 3 } });

  it('picks the earliest-loaded model with geometry, whatever the iteration order', () => {
    const models = [
      { loadedAt: 20, geometryResult: { coordinateInfo: later } },
      { loadedAt: 5, geometryResult: null },
      { loadedAt: 10, geometryResult: { coordinateInfo: anchor } },
    ];
    expect(federationFrameInfo(models)).toBe(anchor);
  });

  it('falls back to a single legacy geometry result, and to null', () => {
    expect(federationFrameInfo([], { coordinateInfo: anchor })).toBe(anchor);
    expect(federationFrameInfo([{ loadedAt: 1, geometryResult: { coordinateInfo: later } }], { coordinateInfo: anchor })).toBe(later);
    expect(federationFrameInfo([])).toBeNull();
  });
});
