/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Test support for site context (#10481 review): the scene/record invariant,
 * and a stand-in for the shared loader for tests that stub `addModel`.
 */

import assert from 'node:assert/strict';
import type { SiteContextLayerKind } from '@ifc-lite/site-context';
import { useViewerStore, type FederatedModel } from '@/store';
import { fixtureModel } from '@/test/store-fixture';
import { adoptSiteContextModel } from '@/lib/site-context/site-context-arrival';
import type { SiteContextArrival } from '@/hooks/modelLoadOptions';

/** The site-context models in the scene are exactly the models the category records point at. */
export function expectSceneMatchesCategories(): void {
  const state = useViewerStore.getState();
  const inScene = [...state.siteContextModels.keys()].sort();
  const referenced = Object.values(state.siteContextCategories)
    .map((c) => c?.modelId)
    .filter((id): id is string => !!id)
    .sort();
  for (const id of new Set([...inScene, ...referenced])) assert.ok(state.models.has(id), `${id} must actually exist in the scene`);
  assert.deepEqual(referenced, inScene, 'every site-context model in the scene has its category record, and only those');
}

/** What the shared loader does once a site-context model of `kind` is in: register it, then the one arrival step. */
export function arriveInScene(modelId: string, kind: SiteContextLayerKind, arrival?: SiteContextArrival): void {
  useViewerStore.setState((s) => ({ models: new Map([...s.models, [modelId, fixtureModel(modelId) as FederatedModel]]) }));
  useViewerStore.getState().registerSiteContextModel(modelId, { kind, attribution: [], issues: [], complete: true, origin: [0, 0, 0] });
  adoptSiteContextModel(modelId, { kind, complete: true, issues: [], attribution: [] }, arrival);
}
