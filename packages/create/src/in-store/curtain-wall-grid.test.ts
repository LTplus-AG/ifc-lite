/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import {
  MutablePropertyView,
  StoreEditor,
  type MutationEntityRef,
  type MutationStoreShape,
} from '@ifc-lite/mutations';
import type { SpatialAnchor, SpatialAnchorSchema } from './anchor.js';
import { addCurtainWallToStore, curtainWallLayout, type CurtainWallInStoreParams } from './curtain-wall.js';
import { addGridToStore, gridIntersectionPlacement, rectangularGridAxes, type GridInStoreParams } from './grid.js';

function setup(schema?: SpatialAnchorSchema, extra: Partial<SpatialAnchor> = {}) {
  const byId = new Map<number, MutationEntityRef>();
  for (let id = 1; id <= 60; id++) {
    byId.set(id, { expressId: id, type: 'IFCDUMMY', byteOffset: 0, byteLength: 1, lineNumber: id });
  }
  const store: MutationStoreShape = { entityIndex: { byId } };
  const view = new MutablePropertyView(null, 'm1');
  const editor = new StoreEditor(store, view);
  const anchor: SpatialAnchor = {
    ownerHistoryId: 5, bodyContextId: 14, axisContextId: 15, rootContextId: 12, storeyId: 43, storeyPlacementId: 54, schema, ...extra,
  };
  const entity = (id: number) => view.getNewEntities().find((e) => e.expressId === id)!;
  const ref = (value: unknown) => entity(Number(String(value).slice(1)));
  /** Location, Axis and RefDirection of an IfcLocalPlacement. */
  const frame = (placementId: number) => {
    const axes = ref(entity(placementId).attributes[1]);
    const dir = (v: unknown) => (v === null ? null : ref(v).attributes[0] as number[]);
    return { parent: entity(placementId).attributes[0], location: ref(axes.attributes[0]).attributes[0], axis: dir(axes.attributes[1]), refDirection: dir(axes.attributes[2]) };
  };
  return { editor, view, anchor, entity, ref, frame };
}

// 3 m x 2.5 m, three 1 m bays, two rows split at 0.9 m.
const CW: CurtainWallInStoreParams = { Start: [1, 2, 0.5], End: [1, 5, 0.5], Height: 2.5, UGrid: 3, VGrid: [0.9] };

describe('curtainWallLayout', () => {
  it('frames a regular grid: edge members inside the outline, transoms between mullion faces', () => {
    // Default 50 mm section.
    const layout = curtainWallLayout(CW);
    expect(layout.length).toBe(3);
    expect(layout.uLines).toEqual([0, 1, 2, 3]);
    expect(layout.vLines).toEqual([0, 0.9, 2.5]);
    expect(layout.mullions).toEqual([0.025, 1, 2, 2.975]);
    // Three rows (bottom edge, 0.9, top edge) in each of three bays.
    expect(layout.transoms).toHaveLength(9);
    expect(layout.transoms.slice(0, 3)).toEqual([
      { v: 0.025, u0: 0.05, u1: 0.975 },
      { v: 0.9, u0: 0.05, u1: 0.975 },
      { v: 2.475, u0: 0.05, u1: 0.975 },
    ]);
    expect(layout.transoms[4]).toEqual({ v: 0.9, u0: 1.025, u1: 1.975 });
    expect(layout.panels).toHaveLength(6);
    expect(layout.panels[0]).toEqual({ u0: 0.05, u1: 0.975, v0: 0.05, v1: 0.875 });
    expect(layout.panels[5]).toEqual({ u0: 2.025, u1: 2.95, v0: 0.925, v1: 2.45 });
  });

  it('takes explicit offsets, drops the perimeter without EdgeMembers, and defaults to bays of at most 1.5 m', () => {
    const layout = curtainWallLayout({ ...CW, UGrid: [0.5, 2], VGrid: undefined, EdgeMembers: false });
    expect(layout.mullions).toEqual([0.5, 2]);
    expect(layout.transoms).toHaveLength(0);
    expect(layout.panels.map((p) => [p.u0, p.u1, p.v0, p.v1])).toEqual([
      [0, 0.475, 0, 2.5], [0.525, 1.975, 0, 2.5], [2.025, 3, 0, 2.5],
    ]);
    expect(curtainWallLayout({ ...CW, UGrid: undefined, End: [1, 6.5, 0.5] }).uLines).toEqual([0, 1.5, 3, 4.5]);
    expect(curtainWallLayout({ ...CW, UGrid: undefined, End: [1, 6.6, 0.5] }).uLines).toHaveLength(5);
  });

  it('uses the profile factory extent for the member widths', () => {
    const layout = curtainWallLayout({ ...CW, MullionProfile: { Type: 'I', OverallWidth: 0.1, OverallDepth: 0.2, WebThickness: 0.01, FlangeThickness: 0.015 } });
    expect(layout.mullions[0]).toBe(0.05);
    expect(layout.panels[0].u0).toBe(0.1);
  });
});

describe('addCurtainWallToStore', () => {
  it('emits an IfcCurtainWall in the storey aggregating mullion and transom IfcMembers and IfcPlate panels', () => {
    const { editor, anchor, entity, frame } = setup('IFC4');
    const r = addCurtainWallToStore(editor, anchor, { ...CW, Name: 'CW1' });

    const cw = entity(r.curtainWallId);
    expect(cw.type).toBe('IfcCurtainWall');
    expect(cw.attributes[2]).toBe('CW1');
    expect(cw.attributes[5]).toBe(`#${r.placementId}`);
    expect(cw.attributes[6]).toBeNull(); // geometry lives on the parts
    expect(cw.attributes[8]).toBe('.NOTDEFINED.');
    expect(entity(r.relContainedId).attributes.slice(4)).toEqual([[`#${r.curtainWallId}`], '#43']);

    expect(r.mullionIds).toHaveLength(4);
    expect(r.transomIds).toHaveLength(9);
    expect(r.panelIds).toHaveLength(6);
    expect(entity(r.relAggregatesId).type).toBe('IfcRelAggregates');
    expect(entity(r.relAggregatesId).attributes.slice(4)).toEqual([
      `#${r.curtainWallId}`,
      [...r.mullionIds, ...r.transomIds, ...r.panelIds].map((id) => `#${id}`),
    ]);
    for (const id of [...r.mullionIds, ...r.transomIds]) {
      expect(entity(id).type).toBe('IfcMember');
      expect(entity(id).attributes[8]).toBe('.MULLION.');
    }
    for (const id of r.panelIds) {
      expect(entity(id).type).toBe('IfcPlate');
      expect(entity(id).attributes[8]).toBe('.CURTAIN_PANEL.');
    }
    expect(entity(r.mullionIds[0]).attributes[2]).toBe('Mullion 1');
    expect(entity(r.transomIds[8]).attributes[2]).toBe('Transom 9');
    expect(entity(r.panelIds[5]).attributes[2]).toBe('Panel 6');

    // The curtain wall sits at Start, local X along the path (+Y here); every part is relative to it.
    expect(frame(r.placementId)).toMatchObject({ parent: '#54', location: [1, 2, 0.5], axis: [0, 0, 1], refDirection: [0, 1, 0] });
    for (const id of [...r.mullionIds, ...r.transomIds, ...r.panelIds]) {
      expect(frame(Number(String(entity(id).attributes[5]).slice(1))).parent).toBe(`#${r.placementId}`);
    }
  });

  it('extrudes mullions up the wall and transoms along it, with profile Y across the wall on both', () => {
    const { editor, anchor, entity, ref, frame } = setup('IFC4');
    const r = addCurtainWallToStore(editor, anchor, CW);
    const placementOf = (id: number) => frame(Number(String(entity(id).attributes[5]).slice(1)));
    const first = (list: unknown) => (list as string[])[0];
    const solidOf = (id: number) => ref(first(ref(first(ref(entity(id).attributes[6]).attributes[2])).attributes[3]));

    expect(placementOf(r.mullionIds[1])).toMatchObject({ location: [1, 0, 0], axis: null, refDirection: null });
    expect(solidOf(r.mullionIds[1]).attributes[3]).toBe(2.5);
    expect(ref(solidOf(r.mullionIds[1]).attributes[0]).attributes.slice(3)).toEqual([{ real: 0.05 }, { real: 0.15 }]);

    // Transom: Z along the path, X down; so profile Y = Z x X = +Y (across the wall), like the mullions.
    expect(placementOf(r.transomIds[1])).toMatchObject({ location: [0.05, 0, 0.9], axis: [1, 0, 0], refDirection: [0, 0, -1] });
    expect(solidOf(r.transomIds[1]).attributes[3]).toBeCloseTo(0.925, 12);
    // No TransomProfile: the transoms share the mullion profile.
    expect(r.transomProfileId).toBe(r.mullionProfileId);

    // Panel: a PanelThickness rectangle spanning the clear width, extruded over the clear height.
    expect(placementOf(r.panelIds[0])).toMatchObject({ location: [0.05, 0, 0.05] });
    const panel = solidOf(r.panelIds[0]);
    expect(panel.attributes[3]).toBeCloseTo(0.825, 12);
    const profile = ref(panel.attributes[0]);
    expect(profile.type).toBe('IfcRectangleProfileDef');
    expect(profile.attributes.slice(3)).toEqual([0.925, 0.024]);
  });

  it('builds mullion and transom sections through the profile factory', () => {
    const { editor, anchor, entity } = setup('IFC4');
    const r = addCurtainWallToStore(editor, anchor, {
      ...CW,
      MullionProfile: { Type: 'T', Depth: 0.15, FlangeWidth: 0.06, WebThickness: 0.01, FlangeThickness: 0.01 },
      TransomProfile: { Type: 'RectangleHollow', XDim: 0.05, YDim: 0.1, WallThickness: 0.004 },
      PanelThickness: 0.03,
    });
    expect(entity(r.mullionProfileId).type).toBe('IfcTShapeProfileDef');
    expect(entity(r.transomProfileId).type).toBe('IfcRectangleHollowProfileDef');
    // T flange width is its in-plane extent.
    expect(r.layout.mullions[0]).toBe(0.03);
  });

  it('lays out IFC2X3 (no PredefinedTypes) and IFC4X3', () => {
    const v2 = setup('IFC2X3');
    const r2 = addCurtainWallToStore(v2.editor, v2.anchor, CW);
    expect(v2.entity(r2.curtainWallId).attributes).toHaveLength(8);
    expect(v2.entity(r2.mullionIds[0]).attributes).toHaveLength(8);
    expect(v2.entity(r2.panelIds[0]).attributes).toHaveLength(8);

    const v43 = setup('IFC4X3');
    const r43 = addCurtainWallToStore(v43.editor, v43.anchor, CW);
    expect(v43.entity(r43.panelIds[0]).attributes[8]).toBe('.CURTAIN_PANEL.');
  });

  it('converts to the native length unit', () => {
    const { editor, anchor, entity, frame } = setup('IFC4', { lengthUnitScale: 0.001 });
    const r = addCurtainWallToStore(editor, anchor, CW);
    expect(frame(r.placementId).location).toEqual([1000, 2000, 500]);
    expect(frame(Number(String(entity(r.transomIds[1]).attributes[5]).slice(1))).location).toEqual([50, 0, 900]);
    expect(entity(r.mullionProfileId).attributes.slice(3)).toEqual([{ real: 50 }, { real: 150 }]);
  });

  it.each([
    ['IFC5 model', 'IFC5', {}, /IFC5/],
    ['sloped path', 'IFC4', { End: [1, 5, 1] }, /same height/],
    ['zero-length path', 'IFC4', { End: [1, 2, 0.5] }, /distinct/],
    ['zero height', 'IFC4', { Height: 0 }, /Height/],
    ['fractional bay count', 'IFC4', { UGrid: 2.5 }, /UGrid bay count/],
    ['offset outside the length', 'IFC4', { UGrid: [1, 3.5] }, /UGrid offsets/],
    ['unsorted offsets', 'IFC4', { VGrid: [1.5, 1] }, /VGrid offsets/],
    ['mullions wider than the bay', 'IFC4', { UGrid: 60 }, /no clear opening/],
    ['transoms taller than the row', 'IFC4', { VGrid: [0.06] }, /no clear opening/],
    ['bad profile', 'IFC4', { MullionProfile: { Type: 'Rectangle', XDim: 0, YDim: 0.1 } }, /XDim/],
    ['zero panel', 'IFC4', { PanelThickness: 0 }, /PanelThickness/],
    ['bad PredefinedType', 'IFC4', { PredefinedType: 'GLAZED' }, /PredefinedType/],
    ['bad GlobalId', 'IFC4', { GlobalId: 'nope' }, /GlobalId/],
  ] as Array<[string, SpatialAnchorSchema, Partial<CurtainWallInStoreParams>, RegExp]>)('refuses %s before emitting', (_label, schema, patch, message) => {
    const { editor, anchor, view } = setup(schema);
    expect(() => addCurtainWallToStore(editor, anchor, { ...CW, ...patch })).toThrow(message);
    expect(view.getNewEntities()).toHaveLength(0);
  });

  it('refuses an IFC2X3 curtain wall without an owner history before emitting', () => {
    const { editor, anchor, view } = setup('IFC2X3', { ownerHistoryId: null });
    expect(() => addCurtainWallToStore(editor, anchor, CW)).toThrow(/OwnerHistory is mandatory/);
    expect(view.getNewEntities()).toHaveLength(0);
  });
});

const GRID: GridInStoreParams = {
  Position: [2, 3, 0],
  Direction: Math.PI / 2,
  ...rectangularGridAxes({ UOffsets: [0, 6], VOffsets: [0, 4, 8] }),
  PredefinedType: 'RECTANGULAR',
  Name: 'G1',
};

describe('rectangularGridAxes', () => {
  it('numbers the U axes, letters the V axes and runs each past the outer axes', () => {
    const { UAxes, VAxes } = rectangularGridAxes({ UOffsets: [0, 6], VOffsets: [0, 4, 8], Overhang: 1.5 });
    expect(UAxes).toEqual([
      { Tag: '1', Start: [0, -1.5], End: [0, 9.5] },
      { Tag: '2', Start: [6, -1.5], End: [6, 9.5] },
    ]);
    expect(VAxes.map((a) => a.Tag)).toEqual(['A', 'B', 'C']);
    expect(VAxes[2]).toEqual({ Tag: 'C', Start: [-1.5, 8], End: [7.5, 8] });
    const many = rectangularGridAxes({ UOffsets: [0], VOffsets: Array.from({ length: 28 }, (_, i) => i) });
    expect(many.VAxes.slice(25).map((a) => a.Tag)).toEqual(['Z', 'AA', 'AB']);
  });
});

describe('addGridToStore', () => {
  it('emits an IfcGrid on the storey with tagged U and V axes and a FootPrint curve set', () => {
    const { editor, anchor, entity, ref, frame } = setup('IFC4');
    const r = addGridToStore(editor, anchor, GRID);

    const grid = entity(r.gridId);
    expect(grid.type).toBe('IfcGrid');
    expect(grid.attributes[2]).toBe('G1');
    expect(grid.attributes.slice(5)).toEqual([
      `#${r.placementId}`,
      `#${r.productShapeId}`,
      r.uAxisIds.map((id) => `#${id}`),
      r.vAxisIds.map((id) => `#${id}`),
      null,
      '.RECTANGULAR.',
    ]);
    expect(entity(r.relContainedId).attributes.slice(4)).toEqual([[`#${r.gridId}`], '#43']);
    const f = frame(r.placementId);
    expect(f).toMatchObject({ parent: '#54', location: [2, 3, 0], axis: [0, 0, 1] });
    expect(f.refDirection![0]).toBeCloseTo(0, 12);
    expect(f.refDirection![1]).toBeCloseTo(1, 12);

    const axis = entity(r.vAxisIds[1]);
    expect(axis.type).toBe('IfcGridAxis');
    expect(axis.attributes[0]).toBe('B');
    expect(axis.attributes[2]).toBe('.T.');
    const curve = ref(axis.attributes[1]);
    expect(curve.type).toBe('IfcPolyline');
    expect((curve.attributes[0] as string[]).map((p) => ref(p).attributes[0])).toEqual([[-1, 4], [7, 4]]);

    const rep = entity(r.shapeRepId);
    expect(rep.attributes.slice(0, 3)).toEqual(['#12', 'FootPrint', 'GeometricCurveSet']);
    const set = ref((rep.attributes[3] as string[])[0]);
    expect(set.type).toBe('IfcGeometricCurveSet');
    expect(set.attributes[0]).toHaveLength(5);
  });

  it('writes W axes, drops PredefinedType on IFC2X3 and converts to native units', () => {
    const w = setup('IFC4');
    const rw = addGridToStore(w.editor, w.anchor, { ...GRID, WAxes: [{ Tag: 'W1', Start: [0, 0], End: [6, 8] }], PredefinedType: 'TRIANGULAR' });
    expect(w.entity(rw.gridId).attributes[9]).toEqual([`#${rw.wAxisIds[0]}`]);

    const v2 = setup('IFC2X3');
    const r2 = addGridToStore(v2.editor, v2.anchor, GRID);
    expect(v2.entity(r2.gridId).attributes).toHaveLength(10);

    const mm = setup('IFC4', { lengthUnitScale: 0.001 });
    const rm = addGridToStore(mm.editor, mm.anchor, GRID);
    const curve = mm.ref(mm.entity(rm.uAxisIds[1]).attributes[1]);
    expect((curve.attributes[0] as string[]).map((p) => mm.ref(p).attributes[0])).toEqual([[6000, -1000], [6000, 9000]]);
  });

  it.each([
    ['IFC5 model', 'IFC5', {}, /IFC5/],
    ['no V axes', 'IFC4', { VAxes: [] }, /VAxes needs at least one axis/],
    ['duplicate tag', 'IFC4', { UAxes: [{ Tag: 'A', Start: [0, 0], End: [0, 5] }] }, /"A" is used twice/],
    ['empty tag', 'IFC4', { UAxes: [{ Tag: ' ', Start: [0, 0], End: [0, 5] }] }, /Tag/],
    ['degenerate axis', 'IFC4', { UAxes: [{ Tag: '1', Start: [0, 0], End: [0, 0] }] }, /distinct/],
    ['NaN axis point', 'IFC4', { UAxes: [{ Tag: '1', Start: [0, Number.NaN], End: [0, 1] }] }, /finite/],
    ['bad PredefinedType', 'IFC4', { PredefinedType: 'HEX' }, /PredefinedType/],
  ] as Array<[string, SpatialAnchorSchema, Partial<GridInStoreParams>, RegExp]>)('refuses %s before emitting', (_label, schema, patch, message) => {
    const { editor, anchor, view } = setup(schema);
    expect(() => addGridToStore(editor, anchor, { ...GRID, ...patch })).toThrow(message);
    expect(view.getNewEntities()).toHaveLength(0);
  });
});

describe('gridIntersectionPlacement', () => {
  it('IFC4: an IfcGridPlacement on an IfcVirtualGridIntersection, implicitly in the grid frame', () => {
    const { editor, anchor, entity } = setup('IFC4', { lengthUnitScale: 0.001 });
    const g = addGridToStore(editor, anchor, GRID);
    const r = gridIntersectionPlacement(editor, anchor, {
      Axes: [g.uAxisIds[1], g.vAxisIds[2]], Offsets: [0.1, 0.2], RefDirection: [0, 1], GridPlacementId: g.placementId,
    });
    const placement = entity(r.placementId);
    expect(placement.type).toBe('IfcGridPlacement');
    expect(placement.attributes).toEqual([`#${r.intersectionId}`, `#${r.refDirectionId}`]);
    expect(entity(r.intersectionId).type).toBe('IfcVirtualGridIntersection');
    expect(entity(r.intersectionId).attributes).toEqual([
      [`#${g.uAxisIds[1]}`, `#${g.vAxisIds[2]}`],
      [{ real: 100 }, { real: 200 }],
    ]);
    expect(entity(r.refDirectionId!).attributes[0]).toEqual([0, 1, 0]);
  });

  it('IFC4X3: PlacementRelTo is the grid placement; a second intersection orients it', () => {
    const { editor, anchor, entity } = setup('IFC4X3');
    const g = addGridToStore(editor, anchor, GRID);
    const r = gridIntersectionPlacement(editor, anchor, {
      Axes: [g.uAxisIds[0], g.vAxisIds[0]],
      Offsets: [0, 0, 0.5],
      RefDirection: { Axes: [g.uAxisIds[1], g.vAxisIds[0]] },
      GridPlacementId: g.placementId,
    });
    expect(entity(r.placementId).attributes).toEqual([`#${g.placementId}`, `#${r.intersectionId}`, `#${r.refDirectionId}`]);
    expect(entity(r.intersectionId).attributes[1]).toEqual([{ real: 0 }, { real: 0 }, { real: 0.5 }]);
    expect(entity(r.refDirectionId!).type).toBe('IfcVirtualGridIntersection');
    expect(entity(r.refDirectionId!).attributes[1]).toEqual([{ real: 0 }, { real: 0 }]);
  });

  it('IFC2X3: orients only by an intersection', () => {
    const { editor, anchor, view } = setup('IFC2X3');
    const g = addGridToStore(editor, anchor, GRID);
    const before = view.getNewEntities().length;
    expect(() => gridIntersectionPlacement(editor, anchor, { Axes: [g.uAxisIds[0], g.vAxisIds[0]], RefDirection: [1, 0] }))
      .toThrow(/IFC2X3 orients a grid placement only by a second intersection/);
    expect(view.getNewEntities()).toHaveLength(before);
    const r = gridIntersectionPlacement(editor, anchor, { Axes: [g.uAxisIds[0], g.vAxisIds[0]] });
    expect(view.getNewEntities().find((e) => e.expressId === r.placementId)!.attributes).toEqual([`#${r.intersectionId}`, null]);
  });

  it.each([
    ['the same axis twice', (u: number[]) => ({ Axes: [u[0], u[0]] })],
    ['a non-axis', () => ({ Axes: [43, 44] })],
    ['a bad offset', (u: number[], v: number[]) => ({ Axes: [u[0], v[0]], Offsets: [0, Number.NaN] })],
    ['a zero direction', (u: number[], v: number[]) => ({ Axes: [u[0], v[0]], RefDirection: [0, 0] })],
    ['a placement that is not one', (u: number[], v: number[]) => ({ Axes: [u[0], v[0]], GridPlacementId: u[1] })],
  ] as Array<[string, (u: number[], v: number[]) => Parameters<typeof gridIntersectionPlacement>[2]]>)('refuses %s before emitting', (_label, make) => {
    const { editor, anchor, view } = setup('IFC4X3');
    const g = addGridToStore(editor, anchor, GRID);
    const before = view.getNewEntities().length;
    expect(() => gridIntersectionPlacement(editor, anchor, make(g.uAxisIds, g.vAxisIds))).toThrow(/gridIntersectionPlacement/);
    expect(view.getNewEntities()).toHaveLength(before);
  });
});
