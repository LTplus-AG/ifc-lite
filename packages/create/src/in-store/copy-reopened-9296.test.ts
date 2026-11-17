/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { it, expect } from 'vitest';
import { IfcParser, extractPropertiesOnDemand, extractQuantitiesOnDemand } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { copyBatchInStore } from './copy-batch.js';
import { AnchorEntityReader } from './resolve-anchor.js';
import { IfcCreator } from '../index.js';
import { addOrdinaryElementInStore } from './ordinary-element.js';
import { resolveSpatialAnchor } from './resolve-anchor.js';
import { addHostedDoorToStore } from './hosted-fill.js';
import { resolveHostAnchor } from './resolve-host.js';
import { addElementTypeToStore, assignTypeInStore } from './element-type.js';
import { writeTopAttachment } from './storey/storey-attachment.js';
import { asRef } from './style-entity-reader.js';

for (const edit of ['none', 'property', 'quantity'] as const) it(`#9296 copied property definitions remain live after ${edit} edits`, async () => {
  const creator = new IfcCreator();
  const ground = creator.addIfcBuildingStorey({ Name: 'Ground', Elevation: 0 });
  const upper = creator.addIfcBuildingStorey({ Name: 'Upper', Elevation: 3 });
  const third = creator.addIfcBuildingStorey({ Name: 'Third', Elevation: 6 });
  const bytes = new TextEncoder().encode(creator.toIfc().content);
  const parse = (b: Uint8Array) => new IfcParser().parseColumnar(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, { disableWorkerScan: true });
  let store = await parse(bytes), view = new MutablePropertyView(null, 'm'), editor = new StoreEditor(store, view);
  view.setOnDemandExtractor(id => extractPropertiesOnDemand(store, id));
  view.setQuantityExtractor(id => extractQuantitiesOnDemand(store, id));
  const anchor = resolveSpatialAnchor(store, ground, view);
  const wall = addOrdinaryElementInStore(editor, anchor, { kind: 'wall', params: { Start: [0,0,0], End: [8,0,0], Height: 3, Thickness: .2 } });
  addHostedDoorToStore(editor, resolveHostAnchor(store, wall, view), { Offset: 2, Width: .9, Height: 2.1 });
  const type = addElementTypeToStore(editor, anchor, { Type: 'IfcWallType', Name: 'Typed wall', PredefinedType: 'STANDARD' });
  assignTypeInStore(editor, anchor, type.typeId, [wall], []);
  if (edit === 'property') view.setProperty(wall, 'Pset_WallCommon', 'Reference', 'edited');
  if (edit === 'quantity') view.setQuantity(wall, 'Qto_WallBaseQuantities', 'Length', 7);
  writeTopAttachment(view,wall,store.entities.getGlobalId(upper)!,'relative');
  editor.addPropertySet(wall, 'Pset_CopyAudit', [{name:'Code',value:'retained',type:'LABEL'}]);
  const saved = new StepExporter(store,view).export({schema:'IFC4',applyMutations:true}).content;
  store=await parse(saved);view=new MutablePropertyView(null,'fresh');editor=new StoreEditor(store,view);
  view.setOnDemandExtractor(id=>extractPropertiesOnDemand(store,id));view.setQuantityExtractor(id=>extractQuantitiesOnDemand(store,id));
  const copies = copyBatchInStore(store, editor, [wall], [{ targetStoreyId: upper }]);
  for (const result of copies) for (const [copy, source] of result.copiedFrom) view.setEntityAlias(copy, source);
  const second = copyBatchInStore(store, editor, copies.map(c=>c.copyId), [{targetStoreyId:third}]);
  for (const result of second) for (const [copy,source] of result.copiedFrom) view.setEntityAlias(copy,source);
  const output = new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true }).content;
  const reopened = await parse(output), reader = new AnchorEntityReader(reopened, null);
  expect([...reader.ids('IFCRELDEFINESBYPROPERTIES')].length).toBeGreaterThan(0);
  for (const id of [wall, copies[0].copyId, second[0].copyId]) {
    expect(extractPropertiesOnDemand(reopened,id).find(set=>set.name==='Pset_CopyAudit')?.properties[0].value).toBe('retained');
  }
  for (const id of reader.ids('IFCRELDEFINESBYPROPERTIES')) {
    const rel = reader.entity(id)!;
    const definition = asRef(rel.attributes[5]);
    expect(definition, `relationship #${id}`).not.toBeNull();
    expect(reader.entity(definition!), `definition of #${id}`).not.toBeNull();
  }
});
