/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as create from '../index.js';
import * as parser from '@ifc-lite/parser';
import * as mutations from '@ifc-lite/mutations';
import * as exporter from '@ifc-lite/export';
import { lifecycleScene } from '../../../../tests/structural-coverage/probes/lifecycle-scene.mjs';

const pkgs = { create, parser, mutations, exporter };
const parse = (text: string) => new parser.IfcParser().parseColumnar(new TextEncoder().encode(text).buffer, { disableWorkerScan: true });
const ref = (value: unknown) => Number(String(value).slice(1));
function save(text: string, name: string) {
  if (process.env.STRUCTURAL_EXPORT_DIR) writeFileSync(join(process.env.STRUCTURAL_EXPORT_DIR, `${name}.ifc`), text);
}
async function removeSource(text: string, schema: 'IFC2X3' | 'IFC4' | 'IFC4X3', id: number) {
  const store = await parse(text), view = new mutations.MutablePropertyView(null, 'imported');
  create.removeStructuralEntityInStore(store, new mutations.StoreEditor(store, view), id);
  const output = new TextDecoder().decode(new exporter.StepExporter(store, view).export({ schema, applyMutations: true }).content);
  return { store: await parse(output), text: output };
}

// #9668 review: imported Items may contain polylines rather than builder edges.
describe.each(['IFC2X3', 'IFC4', 'IFC4X3'] as const)('%s imported structural ownership', schema => {
  it.each([false, true])('reclaims polyline Points and preserves a shared point (shared=%s)', async shared => {
    const scene = await lifecycleScene(pkgs, schema, 'curve-member');
    const representation = scene.editor.getNewEntities().find(e => e.type === 'IfcTopologyRepresentation')!;
    const edge = scene.editor.getNewEntity(ref((representation.attributes[3] as unknown[])[0]))!;
    const vertices = edge.attributes.map(value => scene.editor.getNewEntity(ref(value))!);
    for (const vertex of vertices) scene.editor.removeEntity(ref(vertex.attributes[0]));
    for (const vertex of vertices) scene.editor.removeEntity(vertex.expressId);
    scene.editor.removeEntity(edge.expressId);
    const pointA = scene.editor.addEntity('IfcCartesianPoint', [[0,0,0]]).expressId;
    const pointB = scene.editor.addEntity('IfcCartesianPoint', [[0,0,5]]).expressId;
    const polyline = scene.editor.addEntity('IfcPolyline', [[`#${pointA}`, `#${pointB}`]]).expressId;
    scene.editor.setEntityType(representation.expressId, 'IfcShapeRepresentation');
    scene.editor.setPositionalAttribute(representation.expressId, 2, 'Curve3D');
    scene.editor.setPositionalAttribute(representation.expressId, 3, [`#${polyline}`]);
    if (shared) {
      const pointC = scene.editor.addEntity('IfcCartesianPoint', [[0,0,6]]).expressId;
      scene.editor.addEntity('IfcPolyline', [[`#${pointB}`, `#${pointC}`]]);
    }
    const before = scene.exportText();
    const after = await removeSource(before, schema, scene.id);
    expect(after.store.entityIndex.byId.has(pointA)).toBe(false);
    expect(after.store.entityIndex.byId.has(pointB)).toBe(shared);
    expect(after.store.entityIndex.byId.size).toBe(scene.before.entities.size + (shared ? 3 : 0));
    save(before, `${schema}-polyline-${shared}-created`);
    save(after.text, `${schema}-polyline-${shared}-removed`);
  });

  it('a scalar edit decodes only its target in a large real source store', async () => {
    const scene = await lifecycleScene(pkgs, schema, 'curve-member');
    const extra = Array.from({ length: 1024 }, (_, i) => `#${1000001+i}=IFCCARTESIANPOINT((${i}.,0.,0.));`).join('\n');
    const store = await parse(scene.exportText().replace('ENDSEC;\nEND-ISO-10303-21;', `${extra}\nENDSEC;\nEND-ISO-10303-21;`));
    expect(store.entityIndex.byId.size).toBeGreaterThan(1024);
    const view = new mutations.MutablePropertyView(null, 'large-source');
    const editor = new mutations.StoreEditor(store, view);
    const decode = vi.spyOn(parser.EntityExtractor.prototype, 'extractEntity');
    try {
      create.editStructuralEntityInStore(store, editor, scene.id, { Name: 'Target-only edit' });
      expect(decode).toHaveBeenCalledTimes(1);
    } finally { decode.mockRestore(); }
    const text = new TextDecoder().decode(new exporter.StepExporter(store, view).export({ schema, applyMutations: true }).content);
    expect(parser.extractStructuralOnDemand(await parse(text)).members[0].name).toBe('Target-only edit');
  });
});

// #9668 review: Values are owned resources, with the same shared-reference rule.
describe.each(['IFC4', 'IFC4X3'] as const)('%s imported load configurations', schema => {
  it.each([false, true])('reclaims Values and keeps a reused load (shared=%s)', async shared => {
    const scene = await lifecycleScene(pkgs, schema, 'curve-member');
    const countBefore = (await parse(scene.exportText())).entityIndex.byId.size;
    const loadA = scene.editor.addEntity('IfcStructuralLoadSingleForce', ['A', 1,0,0,0,0,0]).expressId;
    const loadB = scene.editor.addEntity('IfcStructuralLoadSingleForce', ['B', 2,0,0,0,0,0]).expressId;
    const configuration = scene.editor.addEntity('IfcStructuralLoadConfiguration', ['Values', [`#${loadA}`, `#${loadB}`], [[0], [1]]]).expressId;
    if (shared) scene.editor.addEntity('IfcStructuralLoadConfiguration', ['Shared', [`#${loadB}`], [[0]]]);
    const before = scene.exportText();
    const after = await removeSource(before, schema, configuration);
    expect(after.store.entityIndex.byId.has(loadA)).toBe(false);
    expect(after.store.entityIndex.byId.has(loadB)).toBe(shared);
    expect(after.store.entityIndex.byId.size).toBe(countBefore + (shared ? 2 : 0));
    save(before, `${schema}-configuration-${shared}-created`);
    save(after.text, `${schema}-configuration-${shared}-removed`);
  });
});
