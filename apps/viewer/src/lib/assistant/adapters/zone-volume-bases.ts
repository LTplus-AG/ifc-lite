/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { RelationshipType } from '@ifc-lite/data';
import { IfcQuery } from '@ifc-lite/query';
import { extractProjectUnits, extractTypeQuantitiesOnDemand, readCurrentProjectUnits, readCurrentTypeQuantities, ProjectUnits, type CurrentProjectUnitResult, type IfcDataStore } from '@ifc-lite/parser';
import type { ViewerState } from '@/store';
import type { EntityRef } from '@/store/types';
import { effectiveElementData } from '@/components/viewer/properties/effectiveElementData';
import type { QuantitySet } from '@/components/viewer/properties/encodingUtils';
import { withInheritedTypeQuantities } from '@/lib/zones/inherited-quantities';
import { allBasisBreakdowns, declaredVolumeBases, validEntry, volumeBasisRatioNote, type QuantitySetLike } from '@/lib/zones';

/** Declared shares belong to these exact native sources and overlay revisions,
 * including edits that do not publish a viewer mutationVersion. This walks
 * loaded sources only, never their elements, quantities or geometry. */
export function zoneQuantitySourceIdentity(s: ViewerState): unknown[] {
  const identity: unknown[] = [];
  for (const [modelId, model] of s.models) {
    const view = s.mutationViews.get(modelId);
    identity.push(modelId, model.ifcDataStore, model.ifcDataStore?.source,
      model.sourceContentHash, view, view?.getMutationRevision());
  }
  const legacyView = s.mutationViews.get('__legacy__');
  identity.push(s.ifcDataStore, s.ifcDataStore?.source, legacyView, legacyView?.getMutationRevision());
  return identity;
}

/** Same occurrence-first inherited quantities and file VOLUMEUNIT as the
 * Properties card. Reading evidence must never create a mutation view. */
export function zoneQuantitySources(s: ViewerState) {
  const models = new Map<string, { store: IfcDataStore | null; query: IfcQuery | null; units: CurrentProjectUnitResult }>();
  return (ref: EntityRef) => {
    const legacy = ref.modelId === 'legacy' || ref.modelId === '__legacy__';
    const view = s.mutationViews.get(legacy ? '__legacy__' : ref.modelId);
    let source = models.get(ref.modelId);
    if (!source) {
      const store = (s.models.get(ref.modelId)?.ifcDataStore ?? (legacy ? s.ifcDataStore : null)) as IfcDataStore | null;
      let units: CurrentProjectUnitResult = { status: 'available', reason: null, value: ProjectUnits.empty() };
      if (store && view) units = readCurrentProjectUnits(store, view);
      else if (store?.source?.length) {
        try { units = { status: 'available', reason: null, value: extractProjectUnits(store.source, store.entityIndex) }; }
        catch (error) {
          console.warn('[Assistant] Zone source project units are unreadable', error);
          units = { status: 'unavailable', reason: 'Source project units are unreadable', value: null };
        }
      }
      source = { store, query: store ? new IfcQuery(store) : null, units };
      models.set(ref.modelId, source);
    }
    const own = effectiveElementData(ref.expressId, source.query, view).qsets;
    const current = source.store?.source?.length && view
      ? readCurrentTypeQuantities(source.store, ref.expressId, view) : null;
    const quantities = withInheritedTypeQuantities(own, source.store, ref.expressId,
      RelationshipType.DefinesByType,
      (store, id) => (current ? current.value?.quantities
        : extractTypeQuantitiesOnDemand(store as IfcDataStore, id)?.quantities) as QuantitySet[] | undefined);
    return { quantities: [...quantities],
      scale: source.units.status === 'available' ? source.units.value?.resolvedForUnitType('VOLUMEUNIT')?.siScale ?? 1 : null,
      unitStatus: source.units.status, unitReason: source.units.reason,
      reason: current?.reason ?? null,
      status: !source.store ? 'unavailable-model' : !source.store.source?.length ? 'unverified-without-source'
        : current?.status ?? 'available' };
  };
}

/** Cached native card facts only. Capture neither clips nor fills the cache.
 * Counts precede display bounds; overlap means shares must not be summed. */
export function selectedZoneVolumeBreakdowns(
  s: ViewerState, globalId: number, quantities: readonly QuantitySetLike[], scale: number | null,
  setLimit: number, shareLimit: number,
) {
  const relevant = s.zoneSets.filter(set => s.zoneAssignments.get(globalId)?.[set.id]?.straddles);
  const volumeBases: Array<ReturnType<typeof allBasisBreakdowns>[number] & { zoneSetId: string; shareCount: number; unit: string; ratioNote: string | null }> = [];
  const zoneSets = relevant.slice(0, setLimit).map(set => {
    const cache = validEntry(s.zoneApportionment, set);
    const split = cache?.byElement.get(globalId);
    if (split) volumeBases.push(...allBasisBreakdowns(split, scale === null ? [] : declaredVolumeBases(quantities, scale)).map(basis => ({
      ...basis, zoneSetId: set.id, shareCount: basis.shares.length, shares: basis.shares.slice(0, shareLimit),
      unit: 'm3', ratioNote: volumeBasisRatioNote(basis.basis),
    })));
    return { zoneSetId: set.id, name: set.name,
      status: split ? 'cached' : cache?.refused.has(globalId) ? 'refused' : 'split-not-computed',
      refusal: cache?.refused.get(globalId) ?? null,
      overlapping: split?.overlapping ?? null,
    };
  });
  return { zoneSetCount: relevant.length, zoneSets, volumeBases };
}
