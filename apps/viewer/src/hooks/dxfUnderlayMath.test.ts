/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * DXF underlay mapping math (issue #1782, PR #1794).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  dxfWorldShift,
  dxfElevationRenderY,
  dxfUnderlayToDrawing,
  dxfUnderlayToWorldLines3D,
  dxfUnderlayDrawingBounds,
  resolveEffectiveGeoreferenced,
} from './dxfUnderlayMath.js';
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
    visible3D: true,
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

  // issue #1929: a per-underlay toggle for DXFs authored in map/CRS
  // coordinates rather than IFC world coordinates. `mapToWorld` must only
  // be applied when the entry opts in — this is the regression guard for
  // existing users whose DXFs already line up in IFC world coordinates.
  const mapToWorld = (p: { x: number; y: number }): { x: number; y: number } => ({ x: p.x + 1000, y: p.y + 2000 });

  it('applies mapToWorld before the world->drawing mapping when georeferenced is true', () => {
    const e = entry();
    e.georeferenced = true;
    const data = dxfUnderlayToDrawing(e, { x: 0, y: 0 }, false, mapToWorld);
    const [a] = data.lines[0].points;
    // Raw point (0,0) -> mapToWorld -> (1000, 2000) -> drawing (x, -y).
    close(a.x, 1000);
    close(a.y, -2000);
  });

  it('does NOT apply mapToWorld when georeferenced is false, even if a transform is supplied (default-off regression guard)', () => {
    const e = entry();
    e.georeferenced = false;
    const data = dxfUnderlayToDrawing(e, { x: 0, y: 0 }, false, mapToWorld);
    const [a] = data.lines[0].points;
    close(a.x, 0);
    close(a.y, 0);
  });

  it('does NOT apply mapToWorld when georeferenced is omitted (pre-#1929 entries behave exactly as before)', () => {
    const e = entry(); // e.georeferenced is undefined
    const data = dxfUnderlayToDrawing(e, { x: 0, y: 0 }, false, mapToWorld);
    const [a] = data.lines[0].points;
    close(a.x, 0);
    close(a.y, 0);
  });

  it('defaults mapToWorld itself to identity when the caller omits it, even for a georeferenced entry', () => {
    const e = entry();
    e.georeferenced = true;
    const data = dxfUnderlayToDrawing(e, { x: 0, y: 0 }, false); // no 4th arg
    const [a] = data.lines[0].points;
    close(a.x, 0);
    close(a.y, 0);
  });

  // PR #1965 review, item 3: all four gate tests above use shift={0,0} and
  // a pure-translation mock, both of which COMMUTE with the shift
  // subtraction -- so they can't tell "apply mapToWorld, then subtract
  // shift" (correct) apart from "subtract shift, then apply mapToWorld"
  // (wrong by |R*shift - shift|, which is kilometres for a rotated georef
  // at RTC magnitude). A nonzero shift + a rotating, non-commuting mock
  // closes that gap.
  describe('mapToWorld/shift ordering (PR #1965 review, item 3)', () => {
    // 90-degree rotation: (x, y) -> (y, -x). Does NOT commute with
    // translation, unlike the pure-translation mock above.
    const rotate = (p: { x: number; y: number }): { x: number; y: number } => ({ x: p.y, y: -p.x });
    const shift = { x: 100, y: 50 };

    it('applies mapToWorld BEFORE the shift subtraction (mirrorX false)', () => {
      const e = entry();
      e.georeferenced = true;
      const data = dxfUnderlayToDrawing(e, shift, false, rotate);
      const [a, b] = data.lines[0].points;
      // world = rotate(0,0) = (0,0); x = 0-100 = -100; y = -(0-50) = 50.
      close(a.x, -100);
      close(a.y, 50);
      // world = rotate(10,20) = (20,-10); x = 20-100 = -80; y = -(-10-50) = 60.
      close(b.x, -80);
      close(b.y, 60);
    });

    it('applies mapToWorld BEFORE the shift subtraction (mirrorX true)', () => {
      const e = entry();
      e.georeferenced = true;
      const data = dxfUnderlayToDrawing(e, shift, true, rotate);
      const [a, b] = data.lines[0].points;
      close(a.x, 100);
      close(a.y, 50);
      close(b.x, 80);
      close(b.y, 60);
    });
  });

  // PR #1965 review, item 2 (Codex): a non-unit IfcMapConversion.Scale
  // uniformly scales every mapped line/fill point via `mapToWorld`, but
  // text height used to be computed from `entry.placement.scale` alone --
  // skipping the map transform's own scale factor entirely. A mock
  // `mapToWorld` that scales map-space by 2x (e.g. Scale=0.5, since the
  // inverse transform divides by Scale) makes that omission visible: the
  // text height must scale by the same 2x the geometry does.
  describe('text height follows the mapToWorld scale (PR #1965 review, item 2)', () => {
    const scaledMapToWorld = (p: { x: number; y: number }): { x: number; y: number } => ({ x: p.x * 2, y: p.y * 2 });

    const entryWithText = (): DxfUnderlayState => {
      const e = entry();
      e.underlay.layers[0].texts = [
        { position: { x: 1, y: 1 }, dirX: 1, dirY: 0, height: 3, text: 'LABEL', align: 'left', valign: 'baseline' },
      ];
      return e;
    };

    it('scales text height by the mapToWorld factor when georeferenced', () => {
      const e = entryWithText();
      e.georeferenced = true;
      const data = dxfUnderlayToDrawing(e, { x: 0, y: 0 }, false, scaledMapToWorld);
      close(data.texts[0].height, 3 * 2); // placement.scale (1) * mapToWorld scale (2)
    });

    it('leaves text height at placement.scale alone when NOT georeferenced, even with a scaling transform supplied', () => {
      const e = entryWithText();
      e.georeferenced = false;
      const data = dxfUnderlayToDrawing(e, { x: 0, y: 0 }, false, scaledMapToWorld);
      close(data.texts[0].height, 3);
    });

    it('composes with a non-1 placement.scale', () => {
      const e = entryWithText();
      e.georeferenced = true;
      e.placement.scale = 5;
      const data = dxfUnderlayToDrawing(e, { x: 0, y: 0 }, false, scaledMapToWorld);
      close(data.texts[0].height, 3 * 5 * 2);
    });
  });
});

describe('resolveEffectiveGeoreferenced (PR #1965 review, tri-state georeferenced field)', () => {
  it('explicit true always wins, regardless of availability', () => {
    assert.strictEqual(resolveEffectiveGeoreferenced({ georeferenced: true }, false), true);
    assert.strictEqual(resolveEffectiveGeoreferenced({ georeferenced: true }, true), true);
  });

  it('explicit false always wins, regardless of availability', () => {
    assert.strictEqual(resolveEffectiveGeoreferenced({ georeferenced: false }, true), false);
    assert.strictEqual(resolveEffectiveGeoreferenced({ georeferenced: false }, false), false);
  });

  it('undefined ("auto") follows availability', () => {
    assert.strictEqual(resolveEffectiveGeoreferenced({ georeferenced: undefined }, true), true);
    assert.strictEqual(resolveEffectiveGeoreferenced({ georeferenced: undefined }, false), false);
  });
});

describe('dxfUnderlayToDrawing auto-mode (PR #1965 review: closes the import-time race)', () => {
  const entry = (placement: Partial<DxfUnderlayState['placement']> = {}): DxfUnderlayState => ({
    id: 'u1',
    name: 'test.dxf',
    visible: true,
    visible3D: true,
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
  const mapToWorld = (p: { x: number; y: number }): { x: number; y: number } => ({ x: p.x + 1000, y: p.y + 2000 });

  it('an auto entry (georeferenced omitted) follows the anchor once one becomes available', () => {
    const e = entry(); // e.georeferenced is undefined ("auto")
    const data = dxfUnderlayToDrawing(e, { x: 0, y: 0 }, false, mapToWorld, /* georeferenceAvailable */ true);
    const [a] = data.lines[0].points;
    close(a.x, 1000);
    close(a.y, -2000);
  });

  it('an auto entry stays off while no anchor georeference resolves (the pre-#1929, pre-existing-entry-safe default)', () => {
    const e = entry();
    const data = dxfUnderlayToDrawing(e, { x: 0, y: 0 }, false, mapToWorld, /* georeferenceAvailable */ false);
    const [a] = data.lines[0].points;
    close(a.x, 0);
    close(a.y, 0);
  });

  it('an entry the user explicitly turned OFF stays off even when an anchor georeference is available', () => {
    const e = entry();
    e.georeferenced = false;
    const data = dxfUnderlayToDrawing(e, { x: 0, y: 0 }, false, mapToWorld, /* georeferenceAvailable */ true);
    const [a] = data.lines[0].points;
    close(a.x, 0);
    close(a.y, 0);
  });

  it('an entry the user explicitly turned ON stays on even when no anchor georeference resolves', () => {
    const e = entry();
    e.georeferenced = true;
    const data = dxfUnderlayToDrawing(e, { x: 0, y: 0 }, false, mapToWorld, /* georeferenceAvailable */ false);
    const [a] = data.lines[0].points;
    close(a.x, 1000);
    close(a.y, -2000);
  });
});

describe('dxfUnderlayDrawingBounds (PR #1965 review: NaN bounds must become null)', () => {
  const entry = (): DxfUnderlayState => ({
    id: 'u1',
    name: 'test.dxf',
    visible: true,
    visible3D: true,
    opacity: 1,
    layerVisibility: {},
    placement: { offsetX: 0, offsetY: 0, rotationDeg: 0, scale: 1 },
    underlay: {
      name: 'test.dxf',
      unitScale: 1,
      skipped: {},
      warnings: [],
      bounds: { min: { x: 0, y: 0 }, max: { x: 10, y: 10 } },
      layers: [],
    },
  });

  it('returns finite bounds for a well-formed mapToWorld', () => {
    const e = entry();
    e.georeferenced = true;
    const bounds = dxfUnderlayDrawingBounds(e, { x: 0, y: 0 }, false, (p) => ({ x: p.x + 5, y: p.y + 5 }));
    assert.ok(bounds);
    close(bounds!.min.x, 5);
    close(bounds!.min.y, -15);
  });

  it('returns null (not NaN bounds) when mapToWorld yields a non-finite point — e.g. a malformed IfcMapConversion.Eastings=NaN reaching the chain', () => {
    const e = entry();
    e.georeferenced = true;
    const nanTransform = (p: { x: number; y: number }): { x: number; y: number } => ({ x: p.x + NaN, y: p.y });
    const bounds = dxfUnderlayDrawingBounds(e, { x: 0, y: 0 }, false, nanTransform);
    assert.strictEqual(bounds, null);
  });
});

describe('dxfElevationRenderY (issue #2043)', () => {
  it('defaults elevationIfcZ to 0 and subtracts originShift.y + rtc.z', () => {
    // Y-axis counterpart of dxfWorldShift's X/Z-axis (IFC X/Y) shift:
    // renderY = ifcZ - originShift.y - rtc.z (rtc_as_yup.y = rtc.z).
    const y = dxfElevationRenderY({
      wasmRtcOffset: { x: 0, y: 0, z: 5 },
      originShift: { x: 0, y: 2, z: 0 },
    } as never);
    close(y, 0 - 2 - 5);
  });

  it('honours an explicit elevationIfcZ', () => {
    const y = dxfElevationRenderY({
      wasmRtcOffset: { x: 0, y: 0, z: 1 },
      originShift: { x: 0, y: 3, z: 0 },
    } as never, 10);
    close(y, 10 - 3 - 1);
  });

  it('degenerates to 0 with no coordinateInfo', () => {
    close(dxfElevationRenderY(undefined), 0);
  });
});

describe('dxfUnderlayToWorldLines3D (issue #2043)', () => {
  const entry = (paths: DxfUnderlayState['underlay']['layers'][number]['paths']): DxfUnderlayState => ({
    id: 'u1',
    name: 'test.dxf',
    visible: true,
    visible3D: true,
    opacity: 1,
    layerVisibility: {},
    placement: { offsetX: 0, offsetY: 0, rotationDeg: 0, scale: 1 },
    underlay: {
      name: 'test.dxf',
      unitScale: 1,
      skipped: {},
      warnings: [],
      bounds: { min: { x: 0, y: 0 }, max: { x: 10, y: 10 } },
      layers: [
        { name: 'L', color: '#000000', visible: true, fills: [], texts: [], paths },
      ],
    },
  });

  it('lifts an open 2-point path to one 3D segment at the given elevation, X unmirrored', () => {
    const e = entry([{ points: [{ x: 0, y: 0 }, { x: 10, y: 20 }], closed: false }]);
    const verts = dxfUnderlayToWorldLines3D(e, { x: 100, y: 200 }, 5);
    // worldToDrawing (mirrorX=false): x = world.x - shiftX; z = -(world.y - shiftY)
    // p0 = (0,0)   -> x=-100,           z=-(0-200)=200
    // p1 = (10,20) -> x=10-100=-90,     z=-(20-200)=180
    assert.deepStrictEqual(Array.from(verts), [-100, 5, 200, -90, 5, 180]);
  });

  it('closes a closed path with an extra segment back to the first point', () => {
    const e = entry([{
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
      closed: true,
    }]);
    const verts = dxfUnderlayToWorldLines3D(e, { x: 0, y: 0 }, 0);
    // 3 points, closed -> 3 segments (2 consecutive + 1 closing), 6 verts each
    assert.strictEqual(verts.length, 3 * 6);
    // Closing segment: last point (10,10) -> first point (0,0).
    const closingStart = [verts[12], verts[13], verts[14]];
    const closingEnd = [verts[15], verts[16], verts[17]];
    assert.deepStrictEqual(closingStart, [10, 0, -10]);
    assert.deepStrictEqual(closingEnd, [0, 0, 0]);
  });

  it('skips a layer whose visibility is toggled off', () => {
    const e = entry([{ points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], closed: false }]);
    e.layerVisibility = { L: false };
    const verts = dxfUnderlayToWorldLines3D(e, { x: 0, y: 0 }, 0);
    assert.strictEqual(verts.length, 0);
  });

  it('skips a degenerate single-point path', () => {
    const e = entry([{ points: [{ x: 0, y: 0 }], closed: false }]);
    const verts = dxfUnderlayToWorldLines3D(e, { x: 0, y: 0 }, 0);
    assert.strictEqual(verts.length, 0);
  });

  it('applies mapToWorld only when the effective georeferenced state is on', () => {
    const e = entry([{ points: [{ x: 0, y: 0 }, { x: 1, y: 0 }], closed: false }]);
    e.georeferenced = true;
    const mapToWorld = (p: { x: number; y: number }): { x: number; y: number } => ({ x: p.x + 1000, y: p.y + 2000 });
    const verts = dxfUnderlayToWorldLines3D(e, { x: 0, y: 0 }, 0, mapToWorld, true);
    assert.strictEqual(verts[0], 1000);
    assert.strictEqual(verts[2], -2000);
  });
});
