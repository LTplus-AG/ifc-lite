/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * DXF underlay mapping math (issue #1782, PR #1794).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { dxfWorldShift, dxfUnderlayToDrawing } from './dxfUnderlayMath.js';
import type { DxfUnderlayState } from '@/store/slices/drawing2DSlice';

const close = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `expected ${a} ≈ ${b}`);

describe('dxfWorldShift', () => {
  it('combines wasmRtcOffset and originShift (PR #1794 review)', () => {
    // Canonical pipeline (reproject.ts computeModelCenterInIfcMeters):
    // world_yup = render + originShift + rtc_as_yup, rtc_as_yup = (x, z, -y).
    // IFC-XY of the total render shift is (rtc.x + shift.x, rtc.y - shift.z).
    const shift = dxfWorldShift({
      wasmRtcOffset: { x: 1000, y: 2000, z: 0 },
      originShift: { x: 3, y: 0, z: -7 },
    } as never);
    close(shift.x, 1003);
    close(shift.y, 2007);
  });

  it('degenerates to each offset alone and to zero', () => {
    const rtcOnly = dxfWorldShift({ wasmRtcOffset: { x: 10, y: 20, z: 0 } } as never);
    close(rtcOnly.x, 10);
    close(rtcOnly.y, 20);
    const originOnly = dxfWorldShift({ originShift: { x: 5, y: 1, z: 8 } } as never);
    close(originOnly.x, 5);
    close(originOnly.y, -8);
    const none = dxfWorldShift(undefined);
    close(none.x, 0);
    close(none.y, 0);
  });
});

describe('dxfUnderlayToDrawing', () => {
  const entry = (placement: Partial<DxfUnderlayState['placement']> = {}): DxfUnderlayState => ({
    id: 'u1',
    name: 'test.dxf',
    visible: true,
    opacity: 1,
    layerVisibility: {},
    placement: { offsetX: 0, offsetY: 0, rotationDeg: 0, scale: 1, ...placement },
    underlay: {
      name: 'test.dxf',
      unitScale: 1,
      skipped: {},
      warnings: [],
      bounds: { min: { x: 0, y: 0 }, max: { x: 10, y: 10 } },
      layers: [
        {
          name: 'L',
          color: '#000000',
          visible: true,
          fills: [],
          texts: [],
          paths: [{ points: [{ x: 0, y: 0 }, { x: 10, y: 20 }], closed: false }],
        },
      ],
    },
  });

  it('subtracts the render shift and flips world Y to drawing Y', () => {
    const data = dxfUnderlayToDrawing(entry(), { x: 100, y: 200 }, false);
    const [a, b] = data.lines[0].points;
    close(a.x, -100);
    close(a.y, 200); // -(0 - 200)
    close(b.x, -90);
    close(b.y, 180); // -(20 - 200)
  });

  it('mirrors X before placement so offsets stay in final drawing space', () => {
    const data = dxfUnderlayToDrawing(entry({ offsetX: 1 }), { x: 0, y: 0 }, true);
    const [, b] = data.lines[0].points;
    close(b.x, -9); // mirror(10) = -10, then +1 offset in final space
    close(b.y, -20);
  });

  it('skips hidden layers via the visibility override', () => {
    const e = entry();
    e.layerVisibility = { L: false };
    const data = dxfUnderlayToDrawing(e, { x: 0, y: 0 }, false);
    assert.strictEqual(data.lines.length, 0);
  });
});
