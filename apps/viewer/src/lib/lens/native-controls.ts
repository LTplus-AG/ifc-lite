/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { discoverClasses, discoverDataSources } from '@ifc-lite/lens';
import { useViewerStore } from '@/store';
import { createLensDataProvider } from './index';
import { ruleIsolationOwnsChannel } from '@/components/viewer/lens-visibility-ownership';
import { resolvePresentationIds } from '@/lib/presentation/resolvePresentationIds';
export type LensDiscoveryCategories = { properties?: boolean; quantities?: boolean; classifications?: boolean; materials?: boolean };
type DiscoveryState = ReturnType<typeof useViewerStore.getState>;
const classCache = new WeakMap<DiscoveryState['models'], { store: DiscoveryState['ifcDataStore']; revision: number; classes: ReturnType<typeof discoverClasses> }>();
export function nativeLensClasses(s: DiscoveryState, provider: ReturnType<typeof createLensDataProvider>) {
  const cached = classCache.get(s.models);
  if (cached && cached.store === s.ifcDataStore && cached.revision === s.mutationVersion) return cached.classes;
  const classes = discoverClasses(provider);
  classCache.set(s.models, { store: s.ifcDataStore, revision: s.mutationVersion, classes });
  return classes;
}
export function discoverNativeLensData(categories: LensDiscoveryCategories) {
  const s = useViewerStore.getState();
  if (!s.models.size && !s.ifcDataStore) throw new Error('No loaded model has lens data.');
  const provider = createLensDataProvider(s.models, s.ifcDataStore, s.mutationViews, s.resolveGlobalIdFromModels);
  const classes = nativeLensClasses(s, provider);
  const discovered = discoverDataSources(provider, categories);
  s.setDiscoveredLensData({ propertySets: null, quantitySets: null, classificationSystems: null, materials: null, ...s.discoveredLensData, ...discovered, classes });
  return useViewerStore.getState().discoveredLensData;
}
export function releaseNativeLensRuleIsolation(): void {
  const s = useViewerStore.getState(); const claim = s.lensRuleIsolation;
  if (claim && ruleIsolationOwnsChannel(s.isolatedEntities, claim.entityIds)) s.clearIsolation();
  s.setLensRuleIsolation(null);
}
/** Switch lenses while releasing only isolation owned by the previous lens. */
export function switchNativeLens(id: string | null): void {
  if (useViewerStore.getState().activeLensId === id) return;
  releaseNativeLensRuleIsolation();
  useViewerStore.getState().setActiveLens(id);
}
export function currentNativeLensRuleId(state: Pick<DiscoveryState, 'lensRuleIsolation' | 'isolatedEntities'>): string | null {
  const claim = state.lensRuleIsolation;
  return claim && ruleIsolationOwnsChannel(state.isolatedEntities, claim.entityIds) ? claim.ruleId : null;
}
/** Native same-rule toggle, preserving resolved assembly parts and ownership. */
export function isolateNativeLensRule(ruleId: string): void {
  const s = useViewerStore.getState();
  if (currentNativeLensRuleId(s) === ruleId) { releaseNativeLensRuleIsolation(); return; }
  const matching = s.lensRuleEntityIds.get(ruleId); if (!matching?.length) return;
  const ids = resolvePresentationIds(s.cameraCallbacks?.resolveHighlightIds, matching);
  if (ruleIsolationOwnsChannel(s.isolatedEntities, ids)) s.clearIsolation();
  s.isolateEntities(ids); s.setLensRuleIsolation({ ruleId, entityIds: [...ids] });
}
