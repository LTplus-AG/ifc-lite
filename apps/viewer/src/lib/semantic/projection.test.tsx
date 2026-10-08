/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { IfcCreator } from '@ifc-lite/create';
import { IfcParser } from '@ifc-lite/parser';
import { EntityNode } from '@ifc-lite/query';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { createMutateAdapter } from '@/sdk/adapters/mutate-adapter';
import { createQueryAdapter } from '@/sdk/adapters/query-adapter';
import { createExportAdapter } from '@/sdk/adapters/export-adapter';
import { previewProjection, applyProjection, applyProjections } from './projection';
import { useSemanticSession } from './session';

const original = useViewerStore.getState();
const originalSession = useSemanticSession.getState();
afterEach(() => { useViewerStore.setState(original, true); useSemanticSession.setState(originalSession, true); });
async function fixture() {
  let next = 0;
  const creator = new IfcCreator({ GuidSource: () => String(++next).padStart(22, '0'), Timestamp: 0 });
  const storey = creator.addIfcBuildingStorey({ Name: 'Ground', Elevation: 0 });
  const wall = creator.addIfcWall(storey, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3 });
  const door = creator.addIfcDoor(storey, { Position: [5, 0, 0], Width: 0.9, Height: 2.1 });
  const data = await new IfcParser().parseColumnar(new TextEncoder().encode(creator.toIfc().content).buffer, { disableWorkerScan: true });
  useViewerStore.setState({ ...fixtureModels({ ...fixtureModel('model'), ifcDataStore: data, maxExpressId: Math.max(...data.entities.expressId) }),
    ifcDataStore: data, mutationViews: new Map(), editEnabled: true, mutationVersion: 0, canCollabEdit: () => true });
  const entity = (id: number) => ({ id: `https://example.org/install/${id}`, type: 'Installation', label: 'Installed',
    GlobalId: data.entities.getGlobalId(id), productId: 'https://example.org/product', modelRevision: 'https://example.org/revision' });
  const revisions = new Map([['https://example.org/revision', 'model']]);
  const input = { resource: entity(wall), product: { id: 'https://example.org/product', type: 'Product', label: 'Wall', thermalTransmittance: 300 },
    source: 'https://example.org/source', profile: 'https://example.org/profile/2', profileVersion: '2', retrievedAt: '2026-10-01T00:00:00Z', revisions };
  return { data, wall, door, revisions, input, entity };
}
const properties = (id: number) => createQueryAdapter(useViewerStore).properties({ modelId: 'model', expressId: id });
const value = (id: number, pset: string, name: string) => properties(id).find(set => set.name === pset)?.properties.find(property => property.name === name)?.value;

test('charter #6643: typed thermal projection converts declared units, exports provenance and undoes/redoes atomically', async () => {
  const { input, revisions, wall } = await fixture();
  const plan = previewProjection({ ...input, mappingId: 'wall-thermal-transmittance', unit: 'mW/(m2.K)' });
  assert.equal(plan.value, 0.3); applyProjection(plan, revisions);
  assert.equal(value(wall, 'Pset_WallCommon', 'ThermalTransmittance'), 0.3);
  assert.equal(value(wall, 'Pset_SemanticProjection', 'Unit'), 'W/(m2.K)');
  assert.equal(value(wall, 'Pset_SemanticProjection', 'ProfileVersion'), '2');
  assert.equal(value(wall, 'Pset_SemanticProjection', 'RetrievedAt'), input.retrievedAt);
  const ref = { modelId: 'model', expressId: wall };
  const exported = createExportAdapter(useViewerStore).ifc([ref], { includeMutations: true });
  const bytes = typeof exported === 'string' ? new TextEncoder().encode(exported) : new Uint8Array(exported);
  const reopened = await new IfcParser().parseColumnar(bytes.slice().buffer, { disableWorkerScan: true });
  const id = reopened.entities.getExpressIdByGlobalId(String(input.resource.GlobalId));
  const sets = new EntityNode(reopened, id).properties();
  assert.ok(sets.some(set => set.name === 'Pset_WallCommon' && set.properties.some(property => property.name === 'ThermalTransmittance' && property.value === 0.3)));
  assert.ok(sets.some(set => set.name === 'Pset_SemanticProjection' && set.properties.some(property => property.name === 'EvidenceKind' && property.value === 'Source declaration')));
  const mutation = createMutateAdapter(useViewerStore);
  assert.equal(mutation.undo('model'), true); assert.equal(value(wall, 'Pset_WallCommon', 'ThermalTransmittance'), undefined);
  assert.equal(value(wall, 'Pset_SemanticProjection', 'Source'), undefined);
  assert.equal(mutation.redo('model'), true); assert.equal(value(wall, 'Pset_WallCommon', 'ThermalTransmittance'), 0.3);
});
test('charter #6643: explicit conflict policies skip without writes, reject conflicts, and overwrite with one undo', async () => {
  const { input, wall, revisions } = await fixture();
  const mutation = createMutateAdapter(useViewerStore); const ref = { modelId: 'model', expressId: wall };
  mutation.setProperty(ref, 'Pset_WallCommon', 'ThermalTransmittance', 0.5);
  const configured = { ...input, product: { ...input.product, thermalTransmittance: 0.3 }, mappingId: 'wall-thermal-transmittance' };
  assert.throws(() => previewProjection(configured), /conflicts/);
  const skip = previewProjection({ ...configured, policy: 'skip' }); const version = useViewerStore.getState().mutationVersion;
  applyProjection(skip, revisions); assert.equal(useViewerStore.getState().mutationVersion, version); assert.equal(value(wall, 'Pset_WallCommon', 'ThermalTransmittance'), 0.5);
  applyProjection(previewProjection({ ...configured, policy: 'overwrite' }), revisions); assert.equal(value(wall, 'Pset_WallCommon', 'ThermalTransmittance'), 0.3);
  mutation.undo('model'); assert.equal(value(wall, 'Pset_WallCommon', 'ThermalTransmittance'), 0.5);
});
test('charter #6643: projection checks type, units, declaration association, live mutation version and collaboration role', async () => {
  const { input, wall, door, entity, revisions } = await fixture();
  const configured = { ...input, product: { ...input.product, thermalTransmittance: 0.3 }, mappingId: 'wall-thermal-transmittance' };
  assert.throws(() => previewProjection({ ...configured, resource: entity(door) }), /Mapping applies/);
  assert.throws(() => previewProjection({ ...configured, mappingId: 'door-fire-rating', resource: entity(door), product: { ...input.product, fireRating: 'x'.repeat(256) } }), /representable|width|valid/i);
  assert.throws(() => previewProjection({ ...configured, unit: 'unknown' }), /Unsupported/);
  assert.throws(() => previewProjection({ ...configured, product: { ...input.product, id: 'https://example.org/wrong' } }), /its product/);
  const plan = previewProjection(configured);
  createMutateAdapter(useViewerStore).setProperty({ modelId: 'model', expressId: wall }, 'Pset_WallCommon', 'Reference', 'unrelated edit');
  assert.throws(() => applyProjection(plan, revisions), /stale/);
  const latest = previewProjection(configured); useViewerStore.setState({ canCollabEdit: () => false });
  assert.throws(() => applyProjection(latest, revisions), /collab-role/); assert.equal(value(wall, 'Pset_WallCommon', 'ThermalTransmittance'), undefined);
});
test('charter #6643 review: model replacement with reused addresses and GlobalIds invalidates the preview', async () => {
  const { input, revisions } = await fixture();
  const plan = previewProjection({ ...input, mappingId: 'wall-thermal-transmittance', unit: 'mW/(m2.K)' });
  const replacement = await fixture();
  assert.equal(replacement.input.resource.GlobalId, input.resource.GlobalId);
  assert.equal(replacement.wall, plan.ref.expressId);
  assert.equal(useViewerStore.getState().mutationVersion, plan.mutationVersion);
  assert.throws(() => applyProjection(plan, revisions), /stale/);
  assert.equal(value(replacement.wall, 'Pset_WallCommon', 'ThermalTransmittance'), undefined);
});
test('charter #6643 review: explicit URI and profile-field identities record the resolved canonical GUID and revision', async () => {
  const { input, revisions, wall } = await fixture();
  const { GlobalId, modelRevision, ...resource } = input.resource;
  assert.equal(typeof GlobalId, 'string'); assert.equal(typeof modelRevision, 'string');
  useSemanticSession.setState({ strategy: 'resource-links', links: [{ resourceId: resource.id, GlobalId: String(GlobalId), modelRevision: String(modelRevision) }] });
  const plan = previewProjection({ ...input, resource, mappingId: 'wall-thermal-transmittance', unit: 'mW/(m2.K)' });
  assert.equal(plan.targetGlobalId, GlobalId); assert.equal(plan.revision, modelRevision); assert.equal(plan.strategy, 'resource-links');
  applyProjection(plan, revisions);
  assert.equal(value(wall, 'Pset_SemanticProjection', 'GlobalId'), GlobalId);
  assert.equal(value(wall, 'Pset_SemanticProjection', 'ModelRevision'), modelRevision);
  assert.equal(value(wall, 'Pset_SemanticProjection', 'IdentityStrategy'), 'resource-links');
  createMutateAdapter(useViewerStore).undo('model');
  useSemanticSession.setState({ strategy: 'profile-fields', identityFields: { GlobalId: 'modelGuid', modelRevision: 'revisionUri' } });
  const custom = previewProjection({ ...input, resource: { ...resource, modelGuid: GlobalId, revisionUri: modelRevision }, mappingId: 'wall-thermal-transmittance', unit: 'mW/(m2.K)' });
  assert.equal(custom.targetGlobalId, GlobalId); assert.equal(custom.revision, modelRevision);
  applyProjection(custom, revisions);
  assert.equal(value(wall, 'Pset_WallCommon', 'ThermalTransmittance'), 0.3);
  assert.equal(value(wall, 'Pset_SemanticProjection', 'IdentityStrategy'), 'profile-fields');
});

test('charter #6643: long semantic identity provenance retains the full URI as IfcText', async () => {
  const { input, revisions, wall } = await fixture();
  const source = 'https://example.org/' + 'a'.repeat(300);
  applyProjection(previewProjection({ ...input, source, mappingId: 'wall-thermal-transmittance', unit: 'mW/(m2.K)' }), revisions);
  const property = properties(wall).find(pset => pset.name === 'Pset_SemanticProjection')?.properties.find(property => property.name === 'Source');
  assert.equal(property?.value, source);
  const exported = createExportAdapter(useViewerStore).ifc([{ modelId: 'model', expressId: wall }], { includeMutations: true });
  const bytes = typeof exported === 'string' ? new TextEncoder().encode(exported) : new Uint8Array(exported);
  const reopened = await new IfcParser().parseColumnar(bytes.slice().buffer, { disableWorkerScan: true });
  const id = reopened.entities.getExpressIdByGlobalId(String(input.resource.GlobalId));
  const saved = new EntityNode(reopened, id).properties().find(pset => pset.name === 'Pset_SemanticProjection')
    ?.properties.find(property => property.name === 'Source');
  assert.equal(saved?.value, source); assert.equal(saved?.dataType, 'IFCTEXT');
});


test('#7000 conflicting installation records cannot overwrite one target in a reviewed batch', async () => {
  const { input, revisions, wall } = await fixture();
  const first = previewProjection({ ...input, mappingId: 'wall-thermal-transmittance', unit: 'mW/(m2.K)' });
  const second = previewProjection({ ...input, resource: { ...input.resource, id: input.resource.id + '-other' },
    product: { ...input.product, thermalTransmittance: 600 }, mappingId: 'wall-thermal-transmittance', unit: 'mW/(m2.K)' });
  assert.throws(() => applyProjections([first, second], revisions), /same IFC property/);
  assert.equal(value(wall, 'Pset_WallCommon', 'ThermalTransmittance'), undefined);
  assert.equal(value(wall, 'Pset_SemanticProjection', 'InstallationId'), undefined);
});
