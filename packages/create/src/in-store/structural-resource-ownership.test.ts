/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as create from '../index.js';
import * as parser from '@ifc-lite/parser';
import * as mutations from '@ifc-lite/mutations';
import * as exporter from '@ifc-lite/export';
import { lifecycleScene } from '../../../../tests/structural-coverage/probes/lifecycle-scene.mjs';

const pkgs = { create, parser, mutations, exporter };
const ref = (value: unknown) => Number(String(value).slice(1));
const parse = (text: string) => new parser.IfcParser().parseColumnar(new TextEncoder().encode(text).buffer, { disableWorkerScan: true });
const save = (text: string, name: string) => {
  if (process.env.STRUCTURAL_EXPORT_DIR) writeFileSync(join(process.env.STRUCTURAL_EXPORT_DIR, `${name}.ifc`), text);
};
async function removeSource(scene: Awaited<ReturnType<typeof lifecycleScene>>, schema: 'IFC2X3' | 'IFC4' | 'IFC4X3', id: number) {
  const created = scene.exportText();
  const store = await parse(created), view = new mutations.MutablePropertyView(null, 'resource-source');
  create.removeStructuralEntityInStore(store, new mutations.StoreEditor(store, view), id);
  const text = new TextDecoder().decode(new exporter.StepExporter(store, view).export({ schema, applyMutations: true }).content);
  return { created, text, after: await parse(text) };
}

// #9668 / #9819: ownership is a resource-graph rule, not a list of representation formats.
describe.each(['IFC2X3', 'IFC4', 'IFC4X3'] as const)('%s schema-directed resource ownership', schema => {
  it('reclaims a trimmed line without treating its numeric trim as an unrelated entity ID', async () => {
    const scene = await lifecycleScene(pkgs, schema, 'curve-member');
    const representation = scene.editor.getNewEntities().find(e => e.type === 'IfcTopologyRepresentation')!;
    const edge = scene.editor.getNewEntity(ref((representation.attributes[3] as unknown[])[0]))!;
    const vertices = edge.attributes.map(value => scene.editor.getNewEntity(ref(value))!);
    for (const vertex of vertices) scene.editor.removeEntity(ref(vertex.attributes[0]));
    for (const vertex of vertices) scene.editor.removeEntity(vertex.expressId);
    scene.editor.removeEntity(edge.expressId);
    const unrelated = scene.editor.addEntity('IfcCartesianPoint', [[99,99,99]]).expressId;
    const origin = scene.editor.addEntity('IfcCartesianPoint', [[0,0,0]]).expressId;
    const direction = scene.editor.addEntity('IfcDirection', [[1,0,0]]).expressId;
    const vector = scene.editor.addEntity('IfcVector', [`#${direction}`, { real: 1 }]).expressId;
    const line = scene.editor.addEntity('IfcLine', [`#${origin}`, `#${vector}`]).expressId;
    const curve = scene.editor.addEntity('IfcTrimmedCurve', [`#${line}`,
      [{ typed: { type: 'IfcParameterValue', value: 0 } }],
      [{ typed: { type: 'IfcParameterValue', value: unrelated } }], true, '.PARAMETER.']).expressId;
    scene.editor.setEntityType(representation.expressId, 'IfcShapeRepresentation');
    scene.editor.setPositionalAttribute(representation.expressId, 2, 'Curve3D');
    scene.editor.setPositionalAttribute(representation.expressId, 3, [`#${curve}`]);
    const result = await removeSource(scene, schema, scene.id);
    expect(new Set(result.after.entityIndex.byId.keys())).toEqual(new Set([...scene.before.entities.keys(), unrelated]));
    save(result.created, `${schema}-resource-trim-created`);
    save(result.text, `${schema}-resource-trim-removed`);
  });
});

describe.each(['IFC4', 'IFC4X3'] as const)('%s nested geometry references', schema => {
  it('reclaims all rows of a B-spline control-point grid and keeps the representation context', async () => {
    const scene = await lifecycleScene(pkgs, schema, 'curve-member');
    const before = await parse(scene.exportText());
    const face = create.addStructuralSurfaceMemberToStore(scene.editor, scene.anchor, {
      Boundary: [[0,0,0], [4,0,0], [4,3,0], [0,3,0]], PredefinedType: 'SHELL', Thickness: 0.2,
    });
    for (const id of [
      ...face.pointIds, ...face.vertexIds, ...face.edgeIds, ...face.orientedEdgeIds,
      face.loopId, face.boundId, face.planePointId, face.normalId, face.refDirectionId,
      face.planePlacementId, face.planeId, face.faceId,
    ]) scene.editor.removeEntity(id);
    const points = Array.from({ length: 3 }, (_, x) => Array.from({ length: 3 }, (_, y) =>
      `#${scene.editor.addEntity('IfcCartesianPoint', [[x,y,0]]).expressId}`));
    const spline = scene.editor.addEntity('IfcBSplineSurfaceWithKnots', [2, 2, points,
      '.PLANE_SURF.', false, false, false, [3,3], [3,3], [0,1], [0,1], '.QUASI_UNIFORM_KNOTS.']).expressId;
    scene.editor.setEntityType(face.topologyRepId, 'IfcShapeRepresentation');
    scene.editor.setPositionalAttribute(face.topologyRepId, 2, 'Surface3D');
    scene.editor.setPositionalAttribute(face.topologyRepId, 3, [`#${spline}`]);
    const result = await removeSource(scene, schema, face.memberId);
    expect(new Set(result.after.entityIndex.byId.keys())).toEqual(new Set(before.entityIndex.byId.keys()));
    save(result.created, `${schema}-resource-grid-created`);
    save(result.text, `${schema}-resource-grid-removed`);
  });
});
