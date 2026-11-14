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

// #9668 / #9819: imported composite curves own their segments and parent curves.
describe.each(['IFC2X3', 'IFC4', 'IFC4X3'] as const)('%s imported composite-curve ownership', schema => {
  it.each(['exclusive', 'segment', 'parent'] as const)('reclaims exclusive descendants and preserves sharing: %s', async sharing => {
    const scene = await lifecycleScene(pkgs, schema, 'curve-member');
    const representation = scene.editor.getNewEntities().find(e => e.type === 'IfcTopologyRepresentation')!;
    const edge = scene.editor.getNewEntity(ref((representation.attributes[3] as unknown[])[0]))!;
    const vertices = edge.attributes.map(value => scene.editor.getNewEntity(ref(value))!);
    for (const vertex of vertices) scene.editor.removeEntity(ref(vertex.attributes[0]));
    for (const vertex of vertices) scene.editor.removeEntity(vertex.expressId);
    scene.editor.removeEntity(edge.expressId);
    const a = scene.editor.addEntity('IfcCartesianPoint', [[0,0,0]]).expressId;
    const b = scene.editor.addEntity('IfcCartesianPoint', [[0,0,5]]).expressId;
    const parent = scene.editor.addEntity('IfcPolyline', [[`#${a}`, `#${b}`]]).expressId;
    const segment = scene.editor.addEntity('IfcCompositeCurveSegment', ['.DISCONTINUOUS.', true, `#${parent}`]).expressId;
    const composite = scene.editor.addEntity('IfcCompositeCurve', [[`#${segment}`], false]).expressId;
    scene.editor.setEntityType(representation.expressId, 'IfcShapeRepresentation');
    scene.editor.setPositionalAttribute(representation.expressId, 2, 'Curve3D');
    scene.editor.setPositionalAttribute(representation.expressId, 3, [`#${composite}`]);
    const kept = new Set<number>();
    if (sharing !== 'exclusive') {
      const otherSegment = sharing === 'segment' ? segment
        : scene.editor.addEntity('IfcCompositeCurveSegment', ['.DISCONTINUOUS.', true, `#${parent}`]).expressId;
      const otherCurve = scene.editor.addEntity('IfcCompositeCurve', [[`#${otherSegment}`], false]).expressId;
      for (const id of [a, b, parent, otherSegment, otherCurve]) kept.add(id);
    }
    const created = scene.exportText();
    const store = await parse(created);
    const view = new mutations.MutablePropertyView(null, 'composite-source');
    create.removeStructuralEntityInStore(store, new mutations.StoreEditor(store, view), scene.id);
    const text = new TextDecoder().decode(new exporter.StepExporter(store, view).export({ schema, applyMutations: true }).content);
    const after = await parse(text);
    expect(after.entityIndex.byId.has(composite)).toBe(false);
    expect(after.entityIndex.byId.has(segment)).toBe(sharing === 'segment');
    const expected = new Set([...scene.before.entities.keys(), ...kept]);
    expect(new Set(after.entityIndex.byId.keys())).toEqual(expected);
    save(created, `${schema}-composite-${sharing}-created`);
    save(text, `${schema}-composite-${sharing}-removed`);
  });
});
