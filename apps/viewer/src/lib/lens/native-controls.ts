/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { discoverClasses, discoverDataSources } from '@ifc-lite/lens';
import { useViewerStore } from '@/store';
import { createLensDataProvider } from './index';
import { ruleIsolationOwnsChannel } from '@/components/viewer/lens-visibility-ownership';
import { resolvePresentationIds } from '@/lib/presentation/resolvePresentationIds';
export type LensDiscoveryCategories = { properties?: boolean; quantities?: boolean; classifications?: boolean; materials?: boolean };
export function discoverNativeLensData(categories: LensDiscoveryCategories) {
  const s = useViewerStore.getState();
  if (!s.models.size && !s.ifcDataStore) throw new Error('No loaded model has lens data.');
  const provider = createLensDataProvider(s.models, s.ifcDataStore, s.mutationViews, s.resolveGlobalIdFromModels);
  const classes = discoverClasses(provider);
  const discovered = discoverDataSources(provider, categories);
  s.setDiscoveredLensData({ propertySets: null, quantitySets: null, classificationSystems: null, materials: null, ...s.discoveredLensData, ...discovered, classes });
  return useViewerStore.getState().discoveredLensData;
}
export function releaseNativeLensRuleIsolation(): void {
  const s = useViewerStore.getState(); const claim = s.lensRuleIsolation;
  if (claim && ruleIsolationOwnsChannel(s.isolatedEntities, claim.entityIds)) s.clearIsolation();
  s.setLensRuleIsolation(null);
}
/** Native same-rule toggle, preserving resolved assembly parts and ownership. */
export function isolateNativeLensRule(ruleId: string): void {
  const s = useViewerStore.getState();
  if (s.lensRuleIsolation?.ruleId === ruleId) { releaseNativeLensRuleIsolation(); return; }
  const matching = s.lensRuleEntityIds.get(ruleId); if (!matching?.length) return;
  const ids = resolvePresentationIds(s.cameraCallbacks?.resolveHighlightIds, matching);
  if (ruleIsolationOwnsChannel(s.isolatedEntities, ids)) s.clearIsolation();
  s.isolateEntities(ids); s.setLensRuleIsolation({ ruleId, entityIds: [...ids] });
}
