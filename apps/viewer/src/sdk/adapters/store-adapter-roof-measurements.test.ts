/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { IfcCreator, addRoofToStore, editFootprintRoofInStore, getFootprintRoofPlaneParts, resolveSpatialAnchor } from '@ifc-lite/create';
import { IfcParser, extractPropertiesOnDemand, extractQuantitiesOnDemand } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { generateIfcGuid } from '@ifc-lite/encoding';
import * as collab from '@ifc-lite/collab';
import { useViewerStore } from '@/store';
import { bindRoomPropertyApi } from '@/lib/collab/room-property-api';
import { registerStoreSlot, pathForEntity } from '@/lib/collab/entity-paths';
import { mirrorRoofMeasurements } from '@/store/slices/mutation-roof-measurements';

for (const host of ['roof', 'plane']) for (const failAfterDeletion of [false, true]) it(`withheld ${host} net quantities leave the room, with rollback=${failAfterDeletion} (#9357 review)`, async t => {
  const creator = new IfcCreator({ Name: 'Roof measurements' });
  const storey = creator.addIfcBuildingStorey({ Name: 'GF', Elevation: 0 });
  const parse = (text: Uint8Array) => new IfcParser().parseColumnar(Uint8Array.from(text).buffer, { disableWorkerScan: true });
  const initial = await parse(new TextEncoder().encode(creator.toIfc().content));
  const authored = new MutablePropertyView(null, 'roof-measures'), writer = new StoreEditor(initial, authored);
  const roof = addRoofToStore(writer, resolveSpatialAnchor(initial, storey, authored), { Position: [0,0,3], Width: 10, Depth: 8,
    Thickness: .25, EdgeSlopes: Array(4).fill(Math.PI/6) });
  const dataStore = await parse(new StepExporter(initial, authored).export({ schema: 'IFC4', applyMutations: true }).content);
  const view = new MutablePropertyView(null, 'roof-measures'), editor = new StoreEditor(dataStore, view);
  view.setOnDemandExtractor(id => extractPropertiesOnDemand(dataStore, id));
  view.setQuantityExtractor(id => extractQuantitiesOnDemand(dataStore, id));
  const parts = getFootprintRoofPlaneParts(dataStore, view, roof.roofId);
  assert.equal(parts.length, 4);
  const session = await collab.createCollabSession({ roomId: 'net-measurements', user: { id: 'owner', name: 'Owner' }, provider: 'memory' });
  const old = useViewerStore.getState();
  t.after(() => { session.dispose(); bindRoomPropertyApi(collab); useViewerStore.setState({ collabSession: old.collabSession,
    collabRoomId: old.collabRoomId, collabRoomModels: old.collabRoomModels }); });
  const slot = { slotId: 'm0', pathPrefix: '/m0' };
  registerStoreSlot(dataStore, slot);
  useViewerStore.setState({ collabSession: session, collabRoomId: session.roomId, collabRoomModels: new Map([['roof-measures', slot]]) });
  bindRoomPropertyApi(collab);
  for (const id of [roof.roofId, ...parts]) {
    const path = pathForEntity(dataStore, id); assert.ok(path);
    collab.createEntity(session.doc, path, { ifcClass: id === roof.roofId ? 'IfcRoof' : 'IfcSlab' });
  }
  const target = { modelId: 'roof-measures', dataStore, view, editor };
  const publish = () => mirrorRoofMeasurements(useViewerStore, target, roof.roofId, view);
  publish();
  for (const id of [roof.roofId, ...parts]) {
    const path = pathForEntity(dataStore, id); assert.ok(path);
    const set = id === roof.roofId ? 'Qto_RoofBaseQuantities' : 'Qto_SlabBaseQuantities';
    for (const name of id === roof.roofId ? ['NetArea'] : ['NetArea', 'NetVolume']) {
      const value = collab.getQuantityValue(session.doc, path, set, name);
      assert.ok(typeof value === 'number' && Number.isFinite(value) && value > 0, `${id} initially publishes ${name}`);
    }
  }
  const before = session.snapshot().data;
  const ownerId = resolveSpatialAnchor(dataStore, storey, view).ownerHistoryId;
  const owner = ownerId === null ? null : `#${ownerId}`;
  // A declared void with unknown geometry makes net measurements unknown.
  const opening = editor.addEntity('IfcOpeningElement', [generateIfcGuid(), owner, 'Unmeasured opening', null, null, null, null, null, '.OPENING.']).expressId;
  editor.addEntity('IfcRelVoidsElement', [generateIfcGuid(), owner, null, null, `#${host === 'roof' ? roof.roofId : parts[0]}`, `#${opening}`]);
  editFootprintRoofInStore(dataStore, editor, roof.roofId, { Thickness: .3 });
  if (failAfterDeletion) {
    let deletions = 0, failed = false;
    bindRoomPropertyApi({ ...collab, deleteQuantityValue: (...args: Parameters<typeof collab.deleteQuantityValue>) => {
      const result = collab.deleteQuantityValue(...args);
      if (!failed && ++deletions === 2) { failed = true; throw new Error('Injected deletion failure'); }
      return result;
    } });
    assert.throws(publish, /Injected deletion failure/);
    assert.deepEqual(session.snapshot().data, before);
    bindRoomPropertyApi(collab);
  }
  publish();
  for (const id of [roof.roofId, ...parts]) {
    const path = pathForEntity(dataStore, id); assert.ok(path);
    const set = id === roof.roofId ? 'Qto_RoofBaseQuantities' : 'Qto_SlabBaseQuantities';
    const unknown = host === 'roof' || id === roof.roofId || id === parts[0];
    if (unknown) assert.equal(collab.getQuantityValue(session.doc, path, set, 'NetArea'), undefined);
    else assert.ok((collab.getQuantityValue(session.doc, path, set, 'NetArea') ?? 0) > 0);
    if (id !== roof.roofId) {
      if (unknown) assert.equal(collab.getQuantityValue(session.doc, path, set, 'NetVolume'), undefined);
      else assert.ok((collab.getQuantityValue(session.doc, path, set, 'NetVolume') ?? 0) > 0);
      assert.ok((collab.getQuantityValue(session.doc, path, set, 'GrossVolume') ?? 0) > 0);
    }
  }
});
