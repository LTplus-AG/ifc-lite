/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { RelationshipType } from '@ifc-lite/data';
import { IfcQuery } from '@ifc-lite/query';
import { extractTypeQuantitiesOnDemand, readCurrentTypeQuantities, type CurrentProjectUnitResult, type IfcDataStore } from '@ifc-lite/parser';
import { zoneFactsFor } from '@/hooks/zoneFacts';
import type { ProvedVolumes } from '@/hooks/useZoneApportionment';
import type { ViewerState } from '@/store';
import { currentProjectUnitContext } from '@/lib/units/current-project-unit-context';
import type { EntityRef } from '@/store/types';
import { effectiveElementData } from '@/components/viewer/properties/effectiveElementData';
import type { QuantitySet } from '@/components/viewer/properties/encodingUtils';
import { withInheritedTypeQuantities } from '@/lib/zones/inherited-quantities';
import { allBasisBreakdowns, declaredVolumeBases, ZONE_QUANTITY_SET_NAME_PREFIX, validEntry, volumeBasisRatioNote } from '@/lib/zones';

/** Shared public unit convention; unresolved declared units and unavailable context are distinct. */
export const ZONE_VOLUME_UNIT_LIMITATIONS = 'When the project context is available but its VOLUMEUNIT is unresolved, implicit declared bases retain the existing Properties card scale-1 SI default; an m3 label does not prove a declared file unit or a measured conversion. When the current project unit context is unavailable, this evidence withholds declared bases, including explicit bases. With available project context, an independently resolved explicit native Unit retains its measured SI conversion; an unresolved explicit Unit is reported as unavailable rather than given a scale-1 default.';

/** Declared shares belong to these exact native sources and overlay revisions,
 * including edits that do not publish a viewer mutationVersion. This walks
 * loaded sources only, never their elements, quantities or geometry. */
export function zoneQuantitySourceIdentity(s: ViewerState, modelIds?: ReadonlySet<string>): unknown[] {
  const identity: unknown[] = [];
  for (const [modelId, model] of s.models) {
    if (modelIds && !modelIds.has(modelId)) continue;
    const view = s.mutationViews.get(modelId);
    identity.push(modelId, model.ifcDataStore, model.ifcDataStore?.source,
      model.sourceContentHash, view, view?.getMutationRevision());
  }
  if (!modelIds || modelIds.has('legacy') || modelIds.has('__legacy__')) {
    const legacyView = s.mutationViews.get('__legacy__');
    identity.push(s.ifcDataStore, s.ifcDataStore?.source, legacyView, legacyView?.getMutationRevision());
  }
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
      const units = currentProjectUnitContext(store, view);
      source = { store, query: store ? new IfcQuery(store) : null, units };
      models.set(ref.modelId, source);
    }
    const own = effectiveElementData(ref.expressId, source.query, view).qsets;
    const current = source.store && view
      ? readCurrentTypeQuantities(source.store, ref.expressId, view) : null;
    const quantities = current
      ? current.status === 'available' && current.value?.quantities.length
        ? [...own, ...current.value.quantities] : own
      : withInheritedTypeQuantities(own, source.store, ref.expressId,
        RelationshipType.DefinesByType,
        (store, id) => extractTypeQuantitiesOnDemand(store as IfcDataStore, id)?.quantities as QuantitySet[] | undefined);
    const nativeQuantities = quantities.filter(set => !set.name.startsWith(ZONE_QUANTITY_SET_NAME_PREFIX));
    const scale = source.units.status === 'available' ? source.units.value?.resolvedForUnitType('VOLUMEUNIT')?.siScale ?? 1 : null;
    const unresolvedBases = new Set<'net' | 'gross' | 'unqualified'>();
    declaredVolumeBases(nativeQuantities, scale, unresolvedBases);
    return { quantities: nativeQuantities, scale,
      unitStatus: unresolvedBases.size ? 'unavailable' : source.units.status,
      unitReason: unresolvedBases.size ? 'Native quantity basis Unit cannot be resolved' : source.units.reason,
      reason: current?.reason ?? null,
      // A verified empty type assignment does not certify source-free occurrence quantities.
      status: !source.store ? 'unavailable-model' : current?.status === 'unavailable' ? 'unavailable'
        : !source.store.source?.length && !current?.value?.quantities.length
          ? 'unverified-without-source' : 'available' };
  };
}

/** Native whole-element facts and cached splits. Capture neither clips nor fills the cache.
 * Counts precede display bounds; overlap means shares must not be summed. */
export function selectedZoneVolumeBreakdowns(
  s: ViewerState, globalId: number, quantities: ReturnType<ReturnType<typeof zoneQuantitySources>>['quantities'], scale: number | null,
  setLimit: number, shareLimit: number, provedVolumes: () => ProvedVolumes,
) {
  const relevant = s.zoneSets.filter(set => (s.zoneAssignments.get(globalId)?.[set.id]?.touchedZoneIds.length ?? 0) > 0);
  const volumeBases: Array<ReturnType<typeof allBasisBreakdowns>[number] & { zoneSetId: string; shareCount: number; unit: string; ratioNote: string | null }> = [];
  const zoneSets = relevant.slice(0, setLimit).map(set => {
    const cache = validEntry(s.zoneApportionment, set);
    const assignment = s.zoneAssignments.get(globalId)![set.id];
    const split = assignment.straddles ? cache?.byElement.get(globalId) : undefined;
    let wholeRefusal: ReturnType<typeof zoneFactsFor>['refusal'] = null;
    if (!assignment.straddles) {
      const names = new Map(set.zones.map(zone => [zone.id, zone.name]));
      const declared = scale === null ? [] : declaredVolumeBases(quantities, scale);
      for (const basis of ['mesh' as const, ...declared.map(value => value.basis)]) {
        const facts = zoneFactsFor(globalId, assignment, names, basis, scale, [...quantities], provedVolumes(), cache);
        if (basis === 'mesh') wholeRefusal = facts.refusal;
        if (facts.refusal) continue;
        const totalM3 = facts.shares.reduce((total, share) => total + share.valueM3, facts.outsideM3);
        volumeBases.push({ basis, quantityName: facts.quantityName, totalM3,
          shares: facts.shares.slice(0, shareLimit).map(share => ({ ...share, fraction: totalM3 === 0 ? 1 : share.valueM3 / totalM3 })),
          outsideM3: facts.outsideM3, zoneSetId: set.id, shareCount: facts.shares.length, unit: 'm3',
          ratioNote: basis === 'mesh' ? null : 'The declared total belongs to the home zone under the native whole-element assignment.' });
      }
    }
    if (split) volumeBases.push(...allBasisBreakdowns(split, scale === null ? [] : declaredVolumeBases(quantities, scale)).map(basis => ({
      ...basis, zoneSetId: set.id, shareCount: basis.shares.length, shares: basis.shares.slice(0, shareLimit),
      unit: 'm3', ratioNote: volumeBasisRatioNote(basis.basis),
    })));
    return { zoneSetId: set.id, name: set.name,
      status: !assignment.straddles ? wholeRefusal ? 'refused' : 'whole-element' : split ? 'cached' : cache?.refused.has(globalId) ? 'refused' : 'split-not-computed',
      refusal: !assignment.straddles ? wholeRefusal : cache?.refused.get(globalId) ?? null,
      overlapping: !assignment.straddles ? false : split?.overlapping ?? null,
    };
  });
  return { zoneSetCount: relevant.length, zoneSets, volumeBases };
}
