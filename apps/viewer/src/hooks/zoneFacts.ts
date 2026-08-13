/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * How much of each element is in each zone, resolved once for every consumer
 * (issue #2508).
 *
 * Extracted from `useZoneWriteBack` when the CSV/Parquet table export arrived,
 * because the two must not be two producers of the same number. A user who
 * exports the table and then writes the psets, or who compares the spreadsheet
 * against another tool's property panel, is comparing the SAME run of the same
 * arithmetic - not two implementations that agree today.
 *
 * Everything here reads the store and the apportionment cache; nothing here
 * writes. See `lib/zones/writeback.ts` for the pure naming/labelling half.
 */

import { MutablePropertyView } from '@ifc-lite/mutations';
import { extractProjectUnits, type IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { resolveEntityRef } from '@/store/resolveEntityRef';
import { configureMutationView } from '@/utils/configureMutationView';
import {
  declaredVolumeBases,
  validEntry,
  ZONE_QUANTITY_SET_NAME_PREFIX,
  type ElementZoneFacts,
  type VolumeBasis,
  type WriteBackRefusal,
  type ZoneSet,
} from '@/lib/zones';
import { computeZoneApportionmentNow, gatherProvedVolumes, type ProvedVolumes } from './useZoneApportionment.js';

/** Per-model things the loop would otherwise re-derive per element. */
export interface ModelContext {
  view: MutablePropertyView;
  volumeSiScale: number;
  store: IfcDataStore | null;
}

function volumeScaleOf(store: IfcDataStore | null): number {
  if (!store || !(store.source?.length > 0)) return 1;
  const scale = extractProjectUnits(store.source, store.entityIndex).resolvedForUnitType('VOLUMEUNIT')?.siScale;
  return Number.isFinite(scale) && (scale ?? 0) > 0 ? (scale as number) : 1;
}

/** Get-or-create a model's overlay. Write-back is often the FIRST thing in a
 *  session to touch a model's properties, so unlike the panels it cannot assume
 *  a view already exists. */
export function contextFor(modelId: string, cache: Map<string, ModelContext | null>): ModelContext | null {
  const cached = cache.get(modelId);
  if (cached !== undefined) return cached;

  const state = useViewerStore.getState();
  const store = (state.models.get(modelId)?.ifcDataStore ?? (modelId === 'legacy' ? state.ifcDataStore : null)) as IfcDataStore | null;
  let view = state.getMutationView(modelId);
  if (!view) {
    if (!store) {
      cache.set(modelId, null);
      return null;
    }
    view = new MutablePropertyView(store.properties || null, modelId);
    configureMutationView(view, store);
    state.registerMutationView(modelId, view);
  }
  const context: ModelContext = { view, volumeSiScale: volumeScaleOf(store), store };
  cache.set(modelId, context);
  return context;
}

/**
 * The element's quantity sets as the session sees them: the file's own, plus
 * any this session edited or created.
 *
 * Read through the mutation VIEW rather than the data store for two reasons.
 * The store's `quantities` table is empty on a lazily-parsed model (quantities
 * live behind `onDemandQuantityMap`, which the view's configured extractor
 * uses), and a NetVolume the user corrected this session is the number they
 * expect to see apportioned.
 */
export function quantitySetsFor(context: ModelContext, expressId: number) {
  return context.view.getQuantitiesForEntity(expressId);
}

/** Resolve the whole-element total on `basis`, plus the quantity name it came
 *  from. `null` total means the file declares nothing on that basis. */
export function declaredTotal(
  qsets: ReturnType<typeof quantitySetsFor>,
  volumeSiScale: number,
  basis: Exclude<VolumeBasis, 'mesh'>,
): { totalM3: number; quantityName: string } | null {
  // A previous run's OWN output is excluded before anything is read off it.
  // Its rows are volumes with no qualifying name, so `unqualified` would
  // otherwise apportion a zone's share as if it were the element's total and
  // feed the result back in on every run.
  const declaredSets = qsets.filter((q) => !q.name.startsWith(ZONE_QUANTITY_SET_NAME_PREFIX));
  const declared = declaredVolumeBases(declaredSets, volumeSiScale);
  const match = declared.find((d) => d.basis === basis);
  return match ? { totalM3: match.valueM3, quantityName: match.quantityName } : null;
}

export interface VolumeResolution {
  shares: Array<{ zoneName: string; valueM3: number }>;
  outsideM3: number;
  refusal: WriteBackRefusal | null;
  quantityName: string | null;
}

/**
 * How much of this element is in each zone, on the chosen basis.
 *
 * A straddler's split is measured (the apportionment cache); a non-straddler's
 * is trivially "all of it, in its home zone" and skips the clip entirely. Both
 * take their MAGNITUDE from the same basis, which is what keeps the two
 * populations addable in one column.
 */
export function resolveVolumes(
  globalId: number,
  straddles: boolean,
  homeZoneName: string | null,
  basis: VolumeBasis,
  qsets: ReturnType<typeof quantitySetsFor>,
  volumeSiScale: number,
  proved: ProvedVolumes,
  apportioned: ReturnType<typeof validEntry>,
): VolumeResolution {
  const declared = basis === 'mesh' ? null : declaredTotal(qsets, volumeSiScale, basis);
  if (basis !== 'mesh' && !declared) {
    return { shares: [], outsideM3: 0, refusal: 'no-declared-quantity', quantityName: null };
  }
  const quantityName = declared?.quantityName ?? null;

  if (straddles) {
    const entry = apportioned?.byElement.get(globalId) ?? null;
    if (!entry) {
      const refusal = (apportioned?.refused.get(globalId) ?? 'no-geometry') as WriteBackRefusal;
      return { shares: [], outsideM3: 0, refusal, quantityName };
    }
    // Overlapping zones double-count, so the shares are individually right but
    // do not add up. A panel can say that beside the numbers; a quantity set
    // cannot, and a reader will add the rows up.
    if (entry.overlapping) {
      return { shares: [], outsideM3: 0, refusal: 'overlapping-zones', quantityName };
    }
    const total = declared ? declared.totalM3 : entry.wholeVolumeM3;
    return {
      shares: entry.shares.map((s) => ({ zoneName: s.zoneName, valueM3: s.fraction * total })),
      outsideM3: entry.outsideFraction * total,
      refusal: null,
      quantityName,
    };
  }

  // Wholly inside one zone. Nothing to split, so nothing to prove about the
  // geometry - on a declared basis this element never touches the renderer.
  if (!homeZoneName) return { shares: [], outsideM3: 0, refusal: 'no-geometry', quantityName };
  if (declared) {
    return { shares: [{ zoneName: homeZoneName, valueM3: declared.totalM3 }], outsideM3: 0, refusal: null, quantityName };
  }
  if (proved.rescaled.has(globalId)) {
    return { shares: [], outsideM3: 0, refusal: 'rescaled-by-alignment', quantityName };
  }
  const mesh = proved.byGlobalId.get(globalId);
  if (mesh === undefined || !Number.isFinite(mesh)) {
    return { shares: [], outsideM3: 0, refusal: 'unproved-solid', quantityName };
  }
  return { shares: [{ zoneName: homeZoneName, valueM3: Math.abs(mesh) }], outsideM3: 0, refusal: null, quantityName };
}

/** One element's row: the facts, plus what a writer needs to reach it. */
export interface ZoneFactsRow {
  globalId: number;
  modelId: string;
  expressId: number;
  facts: ElementZoneFacts;
  /** The model's own declared volume unit, metres cubed per native unit. */
  volumeSiScale: number;
}

/**
 * Every element of `zoneSet`, with its per-zone volumes on `basis`.
 *
 * Recomputes the apportionment when the cache is stale, so a table can never
 * carry volumes from zones that have since moved - the same guarantee, from the
 * same call, that the write-back makes.
 */
export function gatherZoneFacts(zoneSet: ZoneSet, basis: VolumeBasis): ZoneFactsRow[] {
  const state = useViewerStore.getState();
  const zoneNameById = new Map(zoneSet.zones.map((z) => [z.id, z.name]));
  const apportioned = validEntry(state.zoneApportionment, zoneSet) ?? computeZoneApportionmentNow(zoneSet);
  const proved = gatherProvedVolumes();
  const contexts = new Map<string, ModelContext | null>();
  const rows: ZoneFactsRow[] = [];

  for (const [globalId, record] of state.zoneAssignments) {
    const assignment = record[zoneSet.id];
    if (!assignment || assignment.touchedZoneIds.length === 0) continue;
    const ref = resolveEntityRef(globalId);
    const context = contextFor(ref.modelId, contexts);
    if (!context) continue;
    const qsets = quantitySetsFor(context, ref.expressId);
    const facts = zoneFactsFor(globalId, assignment, zoneNameById, basis, context, qsets, proved, apportioned);
    rows.push({
      globalId,
      modelId: ref.modelId,
      expressId: ref.expressId,
      facts,
      volumeSiScale: context.volumeSiScale,
    });
  }
  return rows;
}

/** One element's facts. The shape the assignment record carries is inlined
 *  rather than imported to keep this module free of the store's types. */
export function zoneFactsFor(
  globalId: number,
  assignment: { zoneName: string | null; straddles: boolean; touchedZoneIds: string[] },
  zoneNameById: ReadonlyMap<string, string>,
  basis: VolumeBasis,
  context: ModelContext,
  qsets: ReturnType<typeof quantitySetsFor>,
  proved: ProvedVolumes,
  apportioned: ReturnType<typeof validEntry>,
): ElementZoneFacts {
  const volumes = resolveVolumes(
    globalId,
    assignment.straddles,
    assignment.zoneName,
    basis,
    qsets,
    context.volumeSiScale,
    proved,
    apportioned,
  );
  return {
    globalId,
    homeZoneName: assignment.zoneName,
    // Mapped through the set rather than trusting stored names: the assignment
    // holds zone IDS precisely so a rename cannot leave stale names behind
    // (types.ts).
    touchedZoneNames: assignment.touchedZoneIds.map((id) => zoneNameById.get(id) ?? ''),
    straddles: assignment.straddles,
    ...volumes,
  };
}
