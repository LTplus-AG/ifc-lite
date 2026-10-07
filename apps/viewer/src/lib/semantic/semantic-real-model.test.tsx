/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { IfcParser } from '@ifc-lite/parser';
import { EntityNode } from '@ifc-lite/query';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { createSelectionAdapter } from '@/sdk/adapters/selection-adapter';
import { createQueryAdapter } from '@/sdk/adapters/query-adapter';
import { createExportAdapter } from '@/sdk/adapters/export-adapter';
import { createMutateAdapter } from '@/sdk/adapters/mutate-adapter';
import { resolveResource, type SemanticResource } from '@ifc-lite/semantic';
import { liveEntities, selectResources } from './viewer';
import { previewProjection, applyProjection } from './projection';
const initial = useViewerStore.getState();
afterEach(() => useViewerStore.setState(initial, true));

test('charter #6643: ArchiCAD 20 FZK door identity, federated selection and projected declaration survive IFC export', async context => {
  let bytes: Uint8Array;
  try { bytes = await readFile(new URL('../../../../../tests/models/ara3d/AC20-FZK-Haus.ifc', import.meta.url)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { context.skip('Run pnpm fixtures to fetch the canonical ArchiCAD fixture'); return; }
    throw error;
  }
  // #7046 scrubbed the STEP author header; the externally authored DATA section is unchanged.
  // Keep the whole-file pin aligned with the published fixture, retaining the native GUID/export oracle.
  assert.equal(createHash('sha256').update(bytes).digest('hex'), 'd42ab0dee01173106c16cd823b4614efe188fa15dd65195d95b9879bec59acc5');
  const parser = new IfcParser(); const store = await parser.parseColumnar(new Uint8Array(bytes).buffer, { disableWorkerScan: true });
  const GlobalId = '1Oms875aH3Wg$9l65H2ZGw'; const expressId = 17468;
  assert.equal(store.entities.getExpressIdByGlobalId(GlobalId), expressId);
  assert.equal(store.entities.getTypeName(expressId), 'IfcDoor');
  const source = 'https://example.org/charter-6643/archicad-reference';
  const revision = `${source}/revision/manifest-d42ab0de`;
  const product: SemanticResource = { id: `${source}/synthetic-product`, type: 'Product', label: 'Synthetic fire rating declaration', fireRating: 'EI30' };
  const installation: SemanticResource = { id: `${source}/door-link`, type: 'Installation', label: 'ArchiCAD reference door', GlobalId, modelRevision: revision, productId: product.id };
  const models = ['archicad-a', 'archicad-b'].map((id, index) => ({ ...fixtureModel(id, { idOffset: index * 1000000 }), ifcDataStore: store,
    maxExpressId: Math.max(...store.entities.expressId) }));
  useViewerStore.setState({ ...fixtureModels(...models), ifcDataStore: store, editEnabled: true, mutationViews: new Map(),
    selectedEntityId: null, selectedEntityIds: new Set(), selectedEntity: null, selectedEntities: [] });
  const revisions = new Map([[revision, 'archicad-b']]); const ref = { modelId: 'archicad-b', expressId };
  assert.equal(resolveResource({ ...installation, modelRevision: undefined }, liveEntities(), revisions).status, 'ambiguous');
  assert.deepEqual(resolveResource(installation, liveEntities(), revisions), { status: 'resolved', ref });
  assert.equal(selectResources([installation], revisions), 1);
  assert.deepEqual(createSelectionAdapter(useViewerStore).get(), [ref]);
  assert.ok(useViewerStore.getState().selectedEntityIds.has(1000000 + expressId));
  const before = createQueryAdapter(useViewerStore).properties(ref);
  const plan = previewProjection({ mappingId: 'door-fire-rating', resource: installation, product, revisions, source,
    profile: 'https://example.org/ifc-lite/semantic-pilot/v1', profileVersion: '1.0.0', policy: 'overwrite' });
  applyProjection(plan, revisions);
  const output = createExportAdapter(useViewerStore).ifc([ref], { includeMutations: true });
  const exportBytes = typeof output === 'string' ? new TextEncoder().encode(output) : new Uint8Array(output);
  const reopened = await parser.parseColumnar(exportBytes.slice().buffer, { disableWorkerScan: true });
  const exportedId = reopened.entities.getExpressIdByGlobalId(GlobalId);
  assert.ok(exportedId !== undefined); const psets = new EntityNode(reopened, exportedId).properties();
  assert.ok(psets.some(pset => pset.name === 'Pset_DoorCommon' && pset.properties.some(property => property.name === 'FireRating' && property.value === 'EI30')));
  assert.ok(psets.some(pset => pset.name === 'Pset_SemanticProjection' && pset.properties.some(property => property.name === 'Source' && property.value === source)));
  assert.equal(createMutateAdapter(useViewerStore).undo(ref.modelId), true);
  assert.deepEqual(createQueryAdapter(useViewerStore).properties(ref), before);
  assert.equal(resolveResource({ ...installation, modelRevision: `${revision}-unknown` }, liveEntities(), revisions).status, 'unscoped');
});
