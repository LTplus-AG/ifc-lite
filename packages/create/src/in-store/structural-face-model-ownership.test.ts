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
const parse = (text: string) => new parser.IfcParser().parseColumnar(new TextEncoder().encode(text).buffer, { disableWorkerScan: true });
const save = (text: string, name: string) => {
  if (process.env.STRUCTURAL_EXPORT_DIR) writeFileSync(join(process.env.STRUCTURAL_EXPORT_DIR, `${name}.ifc`), text);
};

// #9668 / #9819: face-based models own connected face sets and their face graphs.
describe.each(['IFC2X3', 'IFC4', 'IFC4X3'] as const)('%s imported face-based structural surfaces', schema => {
  it.each(['exclusive', 'shell', 'face'] as const)('reclaims exclusive faces and preserves sharing: %s', async sharing => {
    const scene = await lifecycleScene(pkgs, schema, 'curve-member');
    const before = await parse(scene.exportText());
    const surface = create.addStructuralSurfaceMemberToStore(scene.editor, scene.anchor, {
      Boundary: [[0,0,0], [4,0,0], [4,3,0], [0,3,0]], PredefinedType: 'SHELL', Thickness: 0.2,
    });
    const shell = scene.editor.addEntity('IfcOpenShell', [[`#${surface.faceId}`]]).expressId;
    const model = scene.editor.addEntity('IfcFaceBasedSurfaceModel', [[`#${shell}`]]).expressId;
    scene.editor.setEntityType(surface.topologyRepId, 'IfcShapeRepresentation');
    scene.editor.setPositionalAttribute(surface.topologyRepId, 2, 'SurfaceModel');
    scene.editor.setPositionalAttribute(surface.topologyRepId, 3, [`#${model}`]);
    const kept = new Set<number>();
    if (sharing !== 'exclusive') {
      const otherShell = sharing === 'shell' ? shell
        : scene.editor.addEntity('IfcOpenShell', [[`#${surface.faceId}`]]).expressId;
      const otherModel = scene.editor.addEntity('IfcFaceBasedSurfaceModel', [[`#${otherShell}`]]).expressId;
      for (const id of [
        ...surface.pointIds, ...surface.vertexIds, ...surface.edgeIds, ...surface.orientedEdgeIds,
        surface.loopId, surface.boundId, surface.planePointId, surface.normalId,
        surface.refDirectionId, surface.planePlacementId, surface.planeId, surface.faceId,
        otherShell, otherModel,
      ]) kept.add(id);
    }
    const created = scene.exportText();
    const store = await parse(created);
    const view = new mutations.MutablePropertyView(null, 'face-model-source');
    create.removeStructuralEntityInStore(store, new mutations.StoreEditor(store, view), surface.memberId);
    const text = new TextDecoder().decode(new exporter.StepExporter(store, view).export({ schema, applyMutations: true }).content);
    const after = await parse(text);
    expect(after.entityIndex.byId.has(model)).toBe(false);
    expect(after.entityIndex.byId.has(shell)).toBe(sharing === 'shell');
    expect(after.entityIndex.byId.has(surface.faceId)).toBe(sharing !== 'exclusive');
    expect(new Set(after.entityIndex.byId.keys())).toEqual(new Set([...before.entityIndex.byId.keys(), ...kept]));
    expect(parser.extractStructuralOnDemand(after).members.map(m => m.expressId)).toEqual([scene.id]);
    save(created, `${schema}-face-model-${sharing}-created`);
    save(text, `${schema}-face-model-${sharing}-removed`);
  });
});
