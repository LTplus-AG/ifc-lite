/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6232: persisted linear grid columns must have independently known physical
 * position, height and section heading in every supported STEP schema/unit.
 * Generated native-unit fixtures supplement the real mounted Bonsai 1/N proof.
 * Geometry cases skip when the official WASM runtime is absent. */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IfcParser, extractPropertiesOnDemand } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter, gridPlacementDependents, serializeEntitySubgraph } from '@ifc-lite/export';
import { IfcAPI, initSync } from '@ifc-lite/wasm';
import { IfcCreator } from '../ifc-creator.js';
import { addGridToStore, gridIntersectionPlacement, rectangularGridAxes } from './grid.js';
import { addColumnToStore } from './column.js';
import { addColumnOnGridToStore } from './grid-column.js';
import { AnchorEntityReader, resolveSpatialAnchor } from './resolve-anchor.js';
import { refId } from './host-geometry-frame.js';

const wasmPath = fileURLToPath(new URL('../../../wasm/pkg/ifc-lite_bg.wasm', import.meta.url));
const wasmAvailable = existsSync(wasmPath);
const parse = (text: string) => new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer, { disableWorkerScan: true });
type Schema = 'IFC2X3' | 'IFC4' | 'IFC4X3';
type Vec3 = [number, number, number];
type Box = { min: Vec3; max: Vec3 };

async function authoring(schema: Schema, millimetres: boolean, branch: 'direct' | 'sibling' | 'intermediate' = 'direct') {
  const creator = new IfcCreator({ Schema: schema, Timestamp: 0 });
  const storeyId = creator.addIfcBuildingStorey({ Name: 'Native grid', Elevation: 0 });
  let text = creator.toIfc().content;
  if (millimetres) {
    expect(text.match(/\.LENGTHUNIT\.,\$,\.METRE\./g)).toHaveLength(1);
    text = text.replace('.LENGTHUNIT.,$,.METRE.', '.LENGTHUNIT.,.MILLI.,.METRE.');
  }
  const source = await parse(text);
  const view = new MutablePropertyView(null, 'grid');
  view.setOnDemandExtractor((id) => extractPropertiesOnDemand(source, id));
  const editor = new StoreEditor(source, view);
  const anchor = resolveSpatialAnchor(source, storeyId, view);
  const scale = millimetres ? .001 : 1;
  expect(anchor.lengthUnitScale).toBe(scale);
  const reader = new AnchorEntityReader(source, view);
  const entity = (id: number) => reader.entity(id)!;
  const axisId = refId(entity(anchor.storeyPlacementId!).attributes[1])!;
  const pointId = refId(entity(axisId).attributes[0])!;
  editor.setPositionalAttribute(pointId, 0, [1 / scale, 2 / scale, 3 / scale]);
  const storeyDirection = editor.addEntity('IfcDirection', [[0, 1, 0]]).expressId;
  editor.setPositionalAttribute(axisId, 2, `#${storeyDirection}`);
  const grid = addGridToStore(editor, anchor, {
    Position: [2, 3, .5], Direction: Math.PI / 2,
    ...rectangularGridAxes({ UOffsets: [0, 6], VOffsets: [0, 4] }),
  });
  const gridAxis = refId(entity(grid.placementId).attributes[1])!;
  const gridPoint = refId(entity(gridAxis).attributes[0])!;
  const gridDirection = refId(entity(gridAxis).attributes[2])!;
  if (branch === 'sibling') {
    // Same physical grid, now a sibling of the storey under the building.
    const parent = refId(entity(anchor.storeyPlacementId!).attributes[0]);
    if (parent === null) throw new Error('Generated fixture has no building placement');
    editor.setPositionalAttribute(grid.placementId, 0, `#${parent}`);
    editor.setPositionalAttribute(gridPoint, 0, [-2 / scale, 4 / scale, 3.5 / scale]);
    editor.setPositionalAttribute(gridDirection, 0, [-1, 0, 0]);
  } else if (branch === 'intermediate') {
    // Intermediate frame [1,-1,.25], -90deg; grid own frame [-4,1,.25],180deg.
    const origin = editor.addEntity('IfcCartesianPoint', [[1 / scale, -1 / scale, .25 / scale]]).expressId;
    const direction = editor.addEntity('IfcDirection', [[0, -1, 0]]).expressId;
    const axis = editor.addEntity('IfcAxis2Placement3D', [`#${origin}`, null, `#${direction}`]).expressId;
    const placement = editor.addEntity('IfcLocalPlacement', [`#${anchor.storeyPlacementId}`, `#${axis}`]).expressId;
    editor.setPositionalAttribute(grid.placementId, 0, `#${placement}`);
    editor.setPositionalAttribute(gridPoint, 0, [-4 / scale, 1 / scale, .25 / scale]);
    editor.setPositionalAttribute(gridDirection, 0, [-1, 0, 0]);
  }
  // Reload before binding: every tested grid axis is now actually file-backed.
  const exported = new StepExporter(source, view).export({ schema, applyMutations: true });
  const store = await parse(new TextDecoder().decode(exported.content));
  const live = new MutablePropertyView(null, 'live');
  live.setOnDemandExtractor((id) => extractPropertiesOnDemand(store, id));
  const draft = new StoreEditor(store, live);
  return {
    store, view: live, editor: draft, anchor: resolveSpatialAnchor(store, storeyId, live), grid, scale,
    gridPoint, storeyAxis: axisId,
    params: { Position: [-2, 9, 1.25] as Vec3, Width: .4, Depth: .2, Height: 3,
      RefDirection: [Math.cos(Math.PI / 6), .5, 0] as Vec3 },
    binding: { GridId: grid.gridId, IntersectingAxes: [grid.uAxisIds[1], grid.vAxisIds[1]] as const },
    exportText: () => new TextDecoder().decode(new StepExporter(store, live).export({ schema, applyMutations: true }).content),
  };
}

/** Actual official mesh positions converted back from viewer Y-up to IFC Z-up. */
function meshBox(api: IfcAPI, text: string, columnId: number): Box {
  const bytes = new TextEncoder().encode(text);
  const pre = api.buildPrePassOnce(bytes);
  const box: Box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  let vertices = 0;
  try {
    const [x, y, z] = pre.rtcOffset ? Array.from(pre.rtcOffset as ArrayLike<number>) : [0, 0, 0];
    const collection = api.processGeometryBatch(bytes, pre.jobs, pre.unitScale, x, y, z, pre.needsShift,
      pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors);
    try {
      for (let i = 0; i < collection.length; i++) {
        const mesh = collection.get(i);
        if (!mesh) continue;
        try {
          if (mesh.expressId !== columnId) continue;
          expect(mesh.ifcType.toUpperCase()).toBe('IFCCOLUMN');
          const positions = mesh.positions;
          const origin = mesh.origin;
          for (let n = 0; n < positions.length; n += 3) {
            const p = [origin[0] + positions[n], -(origin[2] + positions[n + 2]), origin[1] + positions[n + 1]];
            for (let a = 0; a < 3; a++) { box.min[a] = Math.min(box.min[a], p[a]); box.max[a] = Math.max(box.max[a], p[a]); }
            vertices++;
          }
        } finally { mesh.free(); }
      }
    } finally { collection.free(); }
  } finally { api.clearPrePassCache(); }
  expect(vertices).toBeGreaterThan(0);
  return box;
}

function expectedBox(y = 0): Box {
  // Base centre [-8,0,4.25], heading120deg, Width .4, Depth .2, Height3.
  const halfX = .1 + Math.sqrt(3) * .05;
  const halfY = Math.sqrt(3) * .1 + .05;
  return { min: [-8 - halfX, y - halfY, 4.25], max: [-8 + halfX, y + halfY, 7.25] };
}

function expectBox(actual: Box, expected: Box) {
  for (let i = 0; i < 3; i++) {
    expect(actual.min[i]).toBeCloseTo(expected.min[i], 4);
    expect(actual.max[i]).toBeCloseTo(expected.max[i], 4);
  }
}

for (const schema of ['IFC2X3', 'IFC4', 'IFC4X3'] as const) for (const mm of [false, true]) describe(`#6232 grid column ${schema}/${mm ? 'mm' : 'm'}`, () => {
  let api: IfcAPI;
  beforeAll(() => { if (wasmAvailable) { initSync({ module: readFileSync(wasmPath) }); api = new IfcAPI(); } });
  afterAll(() => { api?.free(); });

  for (const damage of ['deleted owner', 'deleted axis', 'ambiguous owner', 'same row', 'retyped owner'] as const) {
    it(`mini export reports ${damage} instead of inventing a grid frame`, async () => {
      const a = await authoring(schema, mm);
      const result = addColumnOnGridToStore(a.editor, a.store, a.anchor, a.params, a.binding);
      expect(gridPlacementDependents(a.store, a.view, new Set([a.grid.gridId]))).toContain(result.columnId);
      if (damage === 'deleted owner') a.editor.removeEntity(a.grid.gridId);
      if (damage === 'deleted axis') a.editor.removeEntity(a.binding.IntersectingAxes[0]);
      if (damage === 'ambiguous owner') {
        const other = addGridToStore(a.editor, a.anchor, rectangularGridAxes({ UOffsets: [0], VOffsets: [0] }));
        a.editor.setPositionalAttribute(other.gridId, 7, [`#${a.binding.IntersectingAxes[0]}`]);
        a.editor.setPositionalAttribute(other.gridId, 8, [`#${a.binding.IntersectingAxes[1]}`]);
      }
      if (damage === 'same row') {
        a.editor.setPositionalAttribute(a.grid.gridId, 7, a.binding.IntersectingAxes.map((id) => `#${id}`));
        a.editor.setPositionalAttribute(a.grid.gridId, 8, []);
      }
      if (damage === 'retyped owner') a.editor.setEntityType(a.grid.gridId, 'IfcBuildingElementProxy');
      const mini = serializeEntitySubgraph(a.store, a.view, { targets: new Set([result.columnId]) });
      expect(mini.unreadable).toContain(result.gridPlacement.placementId);
      expect(gridPlacementDependents(a.store, a.view, new Set([a.grid.gridId]))).not.toContain(result.columnId);
    });
  }

  it.skipIf(!wasmAvailable)('nested grid bindings share the same saved/mini physical frame and dependent closure', async () => {
    const a = await authoring(schema, mm);
    const initial = addColumnOnGridToStore(a.editor, a.store, a.anchor, a.params, a.binding);
    const nested = addGridToStore(a.editor, { ...a.anchor, storeyPlacementId: initial.gridPlacement.placementId }, {
      Position: [0, 0, 0], ...rectangularGridAxes({ UOffsets: [0, 6], VOffsets: [0, 4] }),
    });
    const gp = gridIntersectionPlacement(a.editor, a.anchor, {
      Axes: [nested.uAxisIds[1], nested.vAxisIds[1]], GridPlacementId: nested.placementId,
    }, a.store);
    const column = addColumnToStore(a.editor, { ...a.anchor, storeyPlacementId: gp.placementId }, {
      Position: [0, 0, .75], Width: .4, Depth: .2, Height: 3,
    });
    const dependent = gridPlacementDependents(a.store, a.view, new Set([a.grid.gridId]));
    expect(dependent).toContain(initial.columnId);
    expect(dependent).toContain(nested.gridId);
    expect(dependent).toContain(column.columnId);
    const mini = serializeEntitySubgraph(a.store, a.view, { targets: new Set([column.columnId]) });
    expect(mini.unreadable).toEqual([]);
    expect(mini.ids).toContain(a.grid.gridId);
    expect(mini.ids).toContain(nested.gridId);
    const box: Box = { min: [-14.2, -4.1, 4.25], max: [-13.8, -3.9, 7.25] };
    expectBox(meshBox(api, a.exportText(), column.columnId), box);
    expectBox(meshBox(api, new TextDecoder().decode(mini.bytes), column.columnId), box);
    const restored = await parse(a.exportText());
    expect(gridPlacementDependents(restored, null, new Set([a.grid.gridId]))).toContain(column.columnId);
  });

  for (const branch of ['direct', 'sibling', 'intermediate'] as const) it.skipIf(!wasmAvailable)(`real WASM/export retain position, height and section heading through ${branch} frames`, async () => {
    const a = await authoring(schema, mm, branch);
    const result = addColumnOnGridToStore(a.editor, a.store, a.anchor, a.params, a.binding);
    const text = a.exportText();
    const restored = await parse(text);
    const reader = new AnchorEntityReader(restored, null);
    const column = reader.entity(result.columnId)!;
    expect(column.type.toUpperCase()).toBe('IFCCOLUMN');
    expect(column.attributes[5]).toBe(result.placementId);
    const local = reader.entity(result.placementId)!;
    expect(local.attributes[0]).toBe(result.gridPlacement.placementId);
    const axis = reader.entity(refId(local.attributes[1])!)!;
    expect(reader.entity(refId(axis.attributes[0])!)!.attributes[0]).toEqual([0, 0, .75 / a.scale]);
    const heading = reader.entity(refId(axis.attributes[2])!)!.attributes[0] as number[];
    expect(heading[0]).toBeCloseTo(.5, 10);
    expect(heading[1]).toBeCloseTo(-Math.sqrt(3) / 2, 10);
    const gridPlacement = reader.entity(result.gridPlacement.placementId)!;
    expect(gridPlacement.attributes).toHaveLength(schema === 'IFC4X3' ? 3 : 2);
    if (schema === 'IFC4X3') expect(gridPlacement.attributes[0]).toBe(a.grid.placementId);
    expect(reader.entity(result.relContainedId)!.attributes.slice(4)).toEqual([[result.columnId], a.anchor.storeyId]);
    expectBox(meshBox(api, text, result.columnId), expectedBox());
    // This is the actual viewer re-mesh payload, whose implicit owning-grid
    // context is needed on IFC2X3/IFC4 as well as on whole-file reload.
    const mini = serializeEntitySubgraph(a.store, a.view, { targets: new Set([result.columnId]) });
    expect(mini.unreadable).toEqual([]);
    expectBox(meshBox(api, new TextDecoder().decode(mini.bytes), result.columnId), expectedBox());
    if (branch === 'direct') {
      // A later grid translation changes the saved column's physical frame;
      // the child position itself stays [.0,.0,.75]m, rather than baking world XY.
      const point = new AnchorEntityReader(a.store, a.view).entity(a.gridPoint)!.attributes[0] as number[];
      a.editor.setPositionalAttribute(a.gridPoint, 0, [point[0] + .5 / a.scale, point[1], point[2]]);
      expectBox(meshBox(api, a.exportText(), result.columnId), expectedBox(.5));
    }
  });

  it('a stale moved grid refuses before emitting any binding or column helpers', async () => {
    const a = await authoring(schema, mm);
    const point = new AnchorEntityReader(a.store, a.view).entity(a.gridPoint)!.attributes[0] as number[];
    a.editor.setPositionalAttribute(a.gridPoint, 0, [point[0] + .5 / a.scale, point[1], point[2]]);
    expect(() => addColumnOnGridToStore(a.editor, a.store, a.anchor, a.params, a.binding)).toThrow(/no longer matches/);
    expect(a.view.getNewEntities()).toHaveLength(0);
  });

  it('invalid column parameters roll back the earlier grid-placement helpers atomically', async () => {
    const a = await authoring(schema, mm);
    expect(() => addColumnOnGridToStore(a.editor, a.store, a.anchor, { ...a.params, Width: -1 }, a.binding)).toThrow(/positive/);
    expect(a.view.getNewEntities()).toHaveLength(0);
  });

  it('an invalid section heading also rolls back the grid-placement helpers', async () => {
    const a = await authoring(schema, mm);
    expect(() => addColumnOnGridToStore(a.editor, a.store, a.anchor, { ...a.params, RefDirection: [NaN, 1, 0] }, a.binding)).toThrow(/direction/i);
    expect(a.view.getNewEntities()).toHaveLength(0);
  });

  it('required unreadable storey frames refuse when the grid is a sibling', async () => {
    const a = await authoring(schema, mm, 'sibling');
    a.editor.setPositionalAttribute(a.anchor.storeyPlacementId!, 1, null);
    expect(() => addColumnOnGridToStore(a.editor, a.store, a.anchor, a.params, a.binding)).toThrow(/readable horizontal placement/);
    expect(a.view.getNewEntities()).toHaveLength(0);
  });

  it('an unreadable shared ancestor cancels when neither relative branch needs it', async () => {
    const a = await authoring(schema, mm);
    const reader = new AnchorEntityReader(a.store, a.view);
    const common = refId(reader.entity(a.anchor.storeyPlacementId!)!.attributes[0])!;
    a.editor.setPositionalAttribute(common, 1, null);
    expect(addColumnOnGridToStore(a.editor, a.store, a.anchor, a.params, a.binding).columnId).toBeGreaterThan(0);
  });
});
