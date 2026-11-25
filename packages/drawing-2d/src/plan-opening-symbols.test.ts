/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import type { MeshData } from '@ifc-lite/geometry';
import { generateFloorPlan } from './drawing-generator.js';
import { exportToSVG } from './svg-exporter.js';
import { box } from './drawing-stream.fixtures.test.js';
import { makeEntityKey, type DoorSwingParameters, type Drawing2D, type SymbolParameters } from './types.js';

type V3 = [number, number, number];

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

const options = { useGPU: false, includeHiddenLines: false } as const;
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
    expect(exportToSVG(drawing)).toMatch(/<g data-entity-id="20" data-ifc-type="IfcDoor" data-symbol="door"/);
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

  it('cuts door bodies as before when openingSymbols is false', async () => {
    const drawing = await generateFloorPlan([host, ...door(20, [1, 0, 0])], 1.2, { ...options, openingSymbols: false });
    expect(drawing.planSymbols).toBeUndefined();
    expect(drawing.cutPolygons.some((p) => p.entityId === 20)).toBe(true);
  });

  it('keeps the body of a door whose operation has no symbol, and draws SWING_FIXED_LEFT hinged left', async () => {
    const operations = ['ROLLINGUP', 'SWING_FIXED_RIGHT', 'DOUBLE_DOOR_FOLDING', 'USERDEFINED', 'SWING_FIXED_LEFT'];
    const meshes = [host, ...operations.flatMap((_, i) => door(20 + i, [0.2 + 1.2 * i, 0, 0]))];
    const openings = new Map(operations.map((operationType, i) => [makeEntityKey(0, 20 + i), { operationType }]));
    const drawing = await generateFloorPlan(meshes, 1.2, { ...options, openings });
    expect(symbolsOf(drawing, 'door').map((s) => s.entityId)).toEqual([24]);
    expect(swing(drawing, 24).hingePoint.x).toBeCloseTo(5, 5);
    expect([...new Set(drawing.cutPolygons.filter((p) => p.ifcType === 'IfcDoor').map((p) => p.entityId))].sort()).toEqual([20, 21, 22, 23]);
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
});
