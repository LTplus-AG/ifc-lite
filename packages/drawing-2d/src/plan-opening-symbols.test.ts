/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import type { MeshData } from '@ifc-lite/geometry';
import { generateFloorPlan } from './drawing-generator.js';
import { exportToSVG } from './svg-exporter.js';
import { exportToDXF } from './dxf-exporter.js';
import { box } from './drawing-stream.fixtures.test.js';
import { vec3, vec3Cross, vec3Scale } from './math.js';
import { buildOpeningSymbols } from './symbols/opening-symbols.js';
import { makeEntityKey, type DoorSwingParameters, type Drawing2D, type SymbolParameters, type Vec3 } from './types.js';

type V3 = [number, number, number];

/** A row-major Y-up `localToWorld` with local X along `x`, object-space Z along `z` and origin `t`. */
function frame(x: Vec3, z: Vec3, t: V3): number[] {
  const y = vec3Cross(z, x);
  return [x.x, y.x, z.x, t[0], x.y, y.y, z.y, t[1], x.z, y.z, z.z, t[2], 0, 0, 0, 1];
}

function toWorld(m: readonly number[], [x, y, z]: V3): V3 {
  const row = (r: number) => m[4 * r] * x + m[4 * r + 1] * y + m[4 * r + 2] * z + m[4 * r + 3];
  return [row(0), row(1), row(2)];
}

/** A 0.9 m door leaf whose world positions are its local box moved by `localToWorld`. */
function placedDoor(expressId: number, localToWorld: number[]): MeshData {
  const local = box(expressId, [0, 0, -0.1], [0.9, 2.1, 0], { ifcType: 'IfcDoor', localToWorld });
  const positions = new Float32Array(local.positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    positions.set(toWorld(localToWorld, [local.positions[i], local.positions[i + 1], local.positions[i + 2]]), i);
  }
  return { ...local, positions };
}

/**
 * An IfcDoor as the wasm pipeline emits it: a row-major Y-up `localToWorld` and
 * world positions, in two pieces (leaf and frame). Local X runs along the wall;
 * IFC local +Y, the side the door swings to, is object-space -Z.
 */
function door(expressId: number, at: V3, width = 0.9): MeshData[] {
  const [tx, ty, tz] = at;
  const localToWorld = [1, 0, 0, tx, 0, 1, 0, ty, 0, 0, 1, tz, 0, 0, 0, 1];
  return [0, 0.05].map((inset) =>
    box(expressId, [tx + inset, ty, tz - 0.1], [tx + width - inset, ty + 2.1 - inset, tz], { ifcType: 'IfcDoor', localToWorld }),
  );
}

const baseOptions = { useGPU: false, includeHiddenLines: false } as const;
const options = { ...baseOptions, openingSymbols: true } as const;
const host = box(1, [0, 0, -0.1], [6, 2.7, 0]);
const symbolsOf = (d: Drawing2D, kind: string) => (d.planSymbols ?? []).filter((s) => s.kind === kind);
const isDoorSwing = (p: SymbolParameters | undefined): p is DoorSwingParameters =>
  p !== undefined && 'hingePoint' in p && typeof p.hingePoint === 'object' && typeof p.width === 'number';
const swing = (d: Drawing2D, id: number, modelIndex = 0): DoorSwingParameters => {
  const parameters = symbolsOf(d, 'door').find((s) => s.entityId === id && s.modelIndex === modelIndex)?.symbol.parameters;
  if (!isDoorSwing(parameters)) throw new Error(`no door swing for ${id}`);
  return parameters;
};

const leafAndClosedEnd = (d: Drawing2D, id: number) => {
  const lines = symbolsOf(d, 'door').find((s) => s.entityId === id)?.lines ?? [];
  if (lines.length < 2) throw new Error(`no door lines for ${id}`);
  return { hinge: lines[0].start, leafEnd: lines[0].end, closedEnd: lines[1].start };
};
const expectPoint = (p: { x: number; y: number }, x: number, y: number) => {
  expect(p.x).toBeCloseTo(x, 5);
  expect(p.y).toBeCloseTo(y, 5);
};

describe('headless plans draw door and window symbols (#10932)', () => {
  it('draws one swing per IfcDoor on the cut, hinged per its OperationType, instead of its cut body', async () => {
    const meshes = [host, ...door(20, [1, 0, 0]), ...door(21, [3, 0, 0]), ...door(22, [1, 3, 0])];
    const drawing = await generateFloorPlan(meshes, 1.2, {
      ...options,
      openings: new Map([[makeEntityKey(0, 20), { operationType: 'SINGLE_SWING_LEFT' }], [makeEntityKey(0, 21), { operationType: '.SINGLE_SWING_RIGHT.' }]]),
    });
    expect(symbolsOf(drawing, 'door').map((s) => s.entityId).sort()).toEqual([20, 21]);
    expect(swing(drawing, 20).hingePoint.x).toBeCloseTo(1, 5);
    expect(swing(drawing, 21).hingePoint.x).toBeCloseTo(3.9, 5);
    for (const id of [20, 21]) {
      const { hingePoint, width } = swing(drawing, id);
      const tips = symbolsOf(drawing, 'door').find((s) => s.entityId === id)?.lines.flatMap((l) => [l.start, l.end]) ?? [];
      expect(Math.min(...tips.map((p) => p.y))).toBeLessThan(hingePoint.y - 0.8);
      expect(width).toBeCloseTo(0.9, 5);
    }
    expect(drawing.cutPolygons.filter((p) => p.ifcType === 'IfcDoor')).toEqual([]);
    const group = exportToSVG(drawing).match(/<g data-entity-id="20" data-ifc-type="IfcDoor" data-symbol="door"[^>]*>([^]*?)<\/g>/);
    expect(group).not.toBeNull();
    const svgLines = [...(group?.[1] ?? '').matchAll(/<line x1="([-\d.]+)" y1="([-\d.]+)" x2="([-\d.]+)" y2="([-\d.]+)"\/>/g)].map((m) => m.slice(1).map(Number));
    expect(svgLines).toHaveLength(symbolsOf(drawing, 'door').find((s) => s.entityId === 20)?.lines.length ?? -1);
    const [[hx, hy, lx, ly], ...arc] = svgLines;
    const radius = Math.hypot(lx - hx, ly - hy);
    expect(radius).toBeGreaterThan(0);
    expect(arc.length).toBeGreaterThan(1);
    for (const [x1, y1, x2, y2] of arc) {
      expect(Math.hypot(x1 - hx, y1 - hy)).toBeCloseTo(radius, 2);
      expect(Math.hypot(x2 - hx, y2 - hy)).toBeCloseTo(radius, 2);
    }
  });

  it('draws opening symbols on the storey-relative cut in the render frame (#10932)', async () => {
    const meshes = [...door(20, [1, 5, 0]), ...door(21, [1, 0, 0])];
    const drawing = await generateFloorPlan(meshes, {
      storeyElevation: 2,
      cutHeight: 1.2,
      frame: {
        siteOrigin: { x: 0, y: 0, z: 10 },
        buildingOrigin: { z: 4 },
        wasmRtcOffset: { x: 0, y: 0, z: 11 },
      },
    }, options);
    expect(drawing.config.plane.position).toBeCloseTo(6.2);
    expect(symbolsOf(drawing, 'door').map((s) => s.entityId)).toEqual([20]);
  });

  it('prefers the authored OverallWidth over the mesh extent', async () => {
    const drawing = await generateFloorPlan([host, ...door(20, [1, 0, 0], 1.0)], 1.2, { ...options, openings: new Map([[makeEntityKey(0, 20), { width: 0.885 }]]) });
    expect(swing(drawing, 20).width).toBeCloseTo(0.885, 6);
  });

  it('draws a window symbol in each window opening on the cut', async () => {
    const window = box(30, [4.5, 0.9, -0.1], [5.5, 2.0, 0], { ifcType: 'IfcWindow', localToWorld: [1, 0, 0, 4.5, 0, 1, 0, 0.9, 0, 0, 1, 0, 0, 0, 0, 1] });
    const drawing = await generateFloorPlan([host, window], 1.2, options);
    const windows = symbolsOf(drawing, 'window');
    expect(windows.map((s) => s.entityId)).toEqual([30]);
    expect(windows[0].lines.length).toBeGreaterThanOrEqual(3);
  });

  it('keeps the projection linework of a window that does not cross the cut', async () => {
    const low = box(30, [4.5, 0.2, -0.1], [5.5, 1.0, 0], { ifcType: 'IfcWindow' });
    const drawing = await generateFloorPlan([host, low], 1.2, options);
    expect(symbolsOf(drawing, 'window')).toEqual([]);
    expect(drawing.lines.filter((l) => l.entityId === 30 && l.category === 'projection').length).toBeGreaterThan(0);
  });

  it('reads the opening info of each federated model separately', async () => {
    const second = door(20, [3, 0, 0]).map((m) => ({ ...m, modelIndex: 1 }));
    const drawing = await generateFloorPlan([host, ...door(20, [1, 0, 0]), ...second], 1.2, {
      ...options,
      openings: new Map([
        [makeEntityKey(0, 20), { operationType: 'SINGLE_SWING_LEFT' }],
        [makeEntityKey(1, 20), { operationType: 'SINGLE_SWING_RIGHT', width: 0.85 }],
      ]),
    });
    expect(swing(drawing, 20, 0).hingePoint.x).toBeCloseTo(1, 5);
    expect(swing(drawing, 20, 0).width).toBeCloseTo(0.9, 5);
    expect(swing(drawing, 20, 1).hingePoint.x).toBeGreaterThan(3.45);
    expect(swing(drawing, 20, 1).width).toBeCloseTo(0.85, 6);
  });

  it.each([undefined, false])('keeps opening bodies when openingSymbols is %s', async (openingSymbols) => {
    const window = box(30, [4.5, 0.9, -0.1], [5.5, 2, 0], { ifcType: 'IfcWindow' });
    const legacyOptions = openingSymbols === undefined ? baseOptions : { ...baseOptions, openingSymbols };
    const drawing = await generateFloorPlan([host, ...door(20, [1, 0, 0]), window], 1.2, legacyOptions);
    expect(drawing.planSymbols).toBeUndefined();
    for (const entityId of [20, 30]) {
      expect(drawing.cutPolygons.some((p) => p.entityId === entityId)).toBe(true);
      expect(drawing.lines.some((line) => line.entityId === entityId && line.category === 'cut')).toBe(true);
    }
  });

  it('keeps the body of a door whose operation has no symbol, and draws SINGLE_SWING_LEFT hinged left', async () => {
    const operations = ['ROLLINGUP', 'SWING_FIXED_RIGHT', 'DOUBLE_DOOR_FOLDING', 'USERDEFINED', 'SWING_FIXED_LEFT', 'SINGLE_SWING_LEFT'];
    const meshes = [host, ...operations.flatMap((_, i) => door(20 + i, [0.2 + 1.2 * i, 0, 0]))];
    const openings = new Map(operations.map((operationType, i) => [makeEntityKey(0, 20 + i), { operationType }]));
    const drawing = await generateFloorPlan(meshes, 1.2, { ...options, openings });
    expect(symbolsOf(drawing, 'door').map((s) => s.entityId)).toEqual([25]);
    expect(swing(drawing, 25).hingePoint.x).toBeCloseTo(6.2, 5);
    expect([...new Set(drawing.cutPolygons.filter((p) => p.ifcType === 'IfcDoor').map((p) => p.entityId))].sort()).toEqual([20, 21, 22, 23, 24]);
  });

  it('hinges a door rotated 90 degrees about Y in its own frame', async () => {
    const localToWorld = [0, 0, 1, 2, 0, 1, 0, 0, -1, 0, 0, 3, 0, 0, 0, 1];
    const drawing = await generateFloorPlan([box(20, [1.9, 0, 2.1], [2, 2.1, 3], { ifcType: 'IfcDoor', localToWorld })], 1.2, options);
    const { hinge, leafEnd, closedEnd } = leafAndClosedEnd(drawing, 20);
    expectPoint(hinge, 1.95, 3);
    expectPoint(leafEnd, 1.05, 3);
    expectPoint(closedEnd, 1.95, 2.1);
  });

  it('swings a mirrored door (negative determinant) back to its own closed position', async () => {
    const localToWorld = [-1, 0, 0, 4, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const drawing = await generateFloorPlan([box(20, [3.1, 0, -0.1], [4, 2.1, 0], { ifcType: 'IfcDoor', localToWorld })], 1.2, options);
    const { hinge, leafEnd, closedEnd } = leafAndClosedEnd(drawing, 20);
    expectPoint(hinge, 4, -0.05);
    expectPoint(leafEnd, 4, -0.95);
    expectPoint(closedEnd, 3.1, -0.05);
  });

  it('places a door whose positions are relative to a nonzero MeshData.origin', async () => {
    const localToWorld = [1, 0, 0, 101, 0, 1, 0, 0, 0, 0, 1, 50, 0, 0, 0, 1];
    const drawing = await generateFloorPlan([box(20, [101, 0, 49.9], [101.9, 2.1, 50], { ifcType: 'IfcDoor', localToWorld, origin: [100, 0, 50] })], 1.2, options);
    const { hinge, leafEnd, closedEnd } = leafAndClosedEnd(drawing, 20);
    expectPoint(hinge, 101, 49.95);
    expectPoint(leafEnd, 101, 49.05);
    expectPoint(closedEnd, 101.9, 49.95);
  });

  it('keeps the body of a door whose placement axes are singular in the plan', async () => {
    const r = Math.SQRT1_2;
    const parallel = placedDoor(20, frame(vec3(r, r, 0), vec3(-r, r, 0), [1, 0.8, 0]));
    const lying = placedDoor(21, frame(vec3(1, 0, 0), vec3(0, 1, 0), [3, 1.25, 0]));
    const drawing = await generateFloorPlan([parallel, lying], 1.2, options);
    expect(symbolsOf(drawing, 'door')).toEqual([]);
    expect([...new Set(drawing.cutPolygons.filter((p) => p.ifcType === 'IfcDoor').map((p) => p.entityId))].sort()).toEqual([20, 21]);
  });

  it('centres a tilted door whose plan axes are not orthogonal on its own body', async () => {
    const [c, s, k] = [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6), 0.6];
    const swingTo = vec3(s * k, c * k, -Math.sqrt(1 - k * k));
    const localToWorld = frame(vec3(c, -s, 0), vec3Scale(swingTo, -1), [1, 0, 2]);
    const openings = new Map([[makeEntityKey(0, 20), { width: 0.9 }]]);
    const drawing = await generateFloorPlan([placedDoor(20, localToWorld)], 1.2, { ...options, openings });
    const [cx, , cz] = toWorld(localToWorld, [0.45, 1.05, -0.05]);
    const across = Math.hypot(swingTo.x, swingTo.z);
    const { hinge, leafEnd } = leafAndClosedEnd(drawing, 20);
    expectPoint(hinge, cx - 0.45, cz);
    expectPoint(leafEnd, cx - 0.45 + (0.9 * swingTo.x) / across, cz + (0.9 * swingTo.z) / across);
  });

  it('measures a tilted door without OverallWidth along its own local X', async () => {
    const [c, s, k] = [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6), 0.6];
    const swingTo = vec3(s * k, c * k, -Math.sqrt(1 - k * k));
    const localToWorld = frame(vec3(c, -s, 0), vec3Scale(swingTo, -1), [1, 0, 2]);
    const drawing = await generateFloorPlan([placedDoor(20, localToWorld)], 1.2, options);
    expect(swing(drawing, 20).width).toBeCloseTo(0.9, 5);
    const [cx, , cz] = toWorld(localToWorld, [0.45, 1.05, -0.05]);
    expectPoint(leafAndClosedEnd(drawing, 20).hinge, cx - 0.45, cz);
  });

  it('keeps the body of a door stating an operation outside the enumeration', async () => {
    const openings = new Map([[makeEntityKey(0, 20), { operationType: '.LIFTING_VERTICAL_LEFT.' }]]);
    const drawing = await generateFloorPlan([host, ...door(20, [1, 0, 0])], 1.2, { ...options, openings });
    expect(symbolsOf(drawing, 'door')).toEqual([]);
    expect(drawing.cutPolygons.some((p) => p.entityId === 20)).toBe(true);
  });

  it('measures the mesh when the stated width or wall thickness is not a positive length', async () => {
    const window = box(30, [4.5, 0.9, -0.1], [5.5, 2.0, 0], { ifcType: 'IfcWindow', localToWorld: [1, 0, 0, 4.5, 0, 1, 0, 0.9, 0, 0, 1, 0, 0, 0, 0, 1] });
    for (const bad of [0, -1, Number.NaN]) {
      const openings = new Map([[makeEntityKey(0, 20), { width: bad }], [makeEntityKey(0, 30), { wallThickness: bad }]]);
      const drawing = await generateFloorPlan([host, ...door(20, [1, 0, 0]), window], 1.2, { ...options, openings });
      expect(swing(drawing, 20).width).toBeCloseTo(0.9, 5);
      const points = symbolsOf(drawing, 'window').flatMap((s) => s.lines.flatMap((l) => [l.start, l.end]));
      expect(points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
      expect(Math.max(...points.map((p) => p.y)) - Math.min(...points.map((p) => p.y))).toBeCloseTo(0.1, 5);
    }
  });

  it('leaves orphan type geometry out when the doors were the only placed meshes', async () => {
    const orphanType = box(90, [3, 0, -0.1], [3.9, 2.1, 0], { ifcType: 'IfcDoorType', geometryClass: 1 });
    const drawing = await generateFloorPlan([...door(20, [1, 0, 0]), orphanType], 1.2, options);
    expect(symbolsOf(drawing, 'door').map((s) => s.entityId)).toEqual([20]);
    expect(drawing.cutPolygons.filter((p) => p.entityId === 90)).toEqual([]);
  });

  it('writes the symbols to DXF on their own layer', async () => {
    const drawing = await generateFloorPlan([host, ...door(20, [1, 0, 0])], 1.2, options);
    const symbolLines = symbolsOf(drawing, 'door').flatMap((s) => s.lines).length;
    expect(symbolLines).toBeGreaterThan(1);
    const onLayer = exportToDXF(drawing).split(/\r?\n/).filter((line) => line.trim() === 'IFC-SYMBOLS').length;
    expect(onLayer).toBeGreaterThanOrEqual(symbolLines);
  });

  it('hinges a door without localToWorld at the mirrored point in a flipped view', () => {
    const plain = box(20, [1, 0, -0.1], [2, 2.1, 0], { ifcType: 'IfcDoor' });
    const leaf = (flipped: boolean) => {
      const lines = buildOpeningSymbols([plain], { axis: 'y', position: 1.2, flipped }).find((symbol) => symbol.entityId === 20)?.lines ?? [];
      if (lines.length === 0) throw new Error(`no door lines with flipped=${flipped}`);
      return lines[0];
    };
    expectPoint(leaf(false).start, 1, -0.05);
    expectPoint(leaf(false).end, 1, 0.95);
    expectPoint(leaf(true).start, -1, -0.05);
    expectPoint(leaf(true).end, -1, 0.95);
  });
});
