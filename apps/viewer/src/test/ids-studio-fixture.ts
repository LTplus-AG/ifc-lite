/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A small Studio document built through ops (the same path the UI uses), for
 * the IDS Studio tests: one wall specification requiring
 * Pset_WallCommon.FireRating, plus the loaded schema contexts.
 */

import { commit, createStudioDocument, createStudioState, type StudioDocument, type StudioState, type Uuid } from '@ifc-lite/ids-authoring';
import { loadStudioContexts, type StudioContexts } from '@/lib/ids-studio/context';
import { addFacetOps, addSpecOps } from '@/lib/ids-studio/ops';

export interface WallFixture {
  contexts: StudioContexts;
  state: StudioState;
  doc: StudioDocument;
  specId: Uuid;
  entityId: Uuid;
  propertyId: Uuid;
}

export async function wallFixture(): Promise<WallFixture> {
  const contexts = await loadStudioContexts();
  const spec = addSpecOps({ name: 'Walls – fire rating', ifcVersions: ['IFC4'] });
  const entity = addFacetOps(spec.specId, 'applicability', { type: 'entity', name: { kind: 'equals', value: 'IfcWall' } });
  const property = addFacetOps(spec.specId, 'requirements', {
    type: 'property', propertySet: { kind: 'equals', value: 'Pset_WallCommon' }, baseName: { kind: 'equals', value: 'FireRating' },
  }, 'required');
  const state = commit(createStudioState(createStudioDocument({ title: 'Fire safety' })), [...spec.ops, ...entity.ops, ...property.ops]).state;
  return { contexts, state: { doc: state.doc, history: { past: [], future: [] } }, doc: state.doc, specId: spec.specId, entityId: entity.facetId, propertyId: property.facetId };
}
