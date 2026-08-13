/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Writes one zone set's assignment into the models as IFC property/quantity
 * sets (issue #2508, item 3), so the classification survives an export and
 * stops being viewer-only state.
 *
 * The gathering half of `lib/zones/writeback.ts`: which elements, which model,
 * which volume, in which units. Everything about NAMING and LABELLING lives
 * there and is pure; everything about the store lives here.
 *
 * ## Where each number comes from
 *
 * - A STRADDLER's fractions come from the apportionment cache - the same entry
 *   #2515 fills and the Lists columns read, so the file cannot disagree with the
 *   panel. Missing or stale, it is computed first rather than silently skipped.
 * - A NON-STRADDLER needs no clip at all: all of it is in its home zone. On a
 *   declared basis that means it needs no geometry either, which is why an
 *   element the kernel could not prove still gets a `net` breakdown.
 * - Every value is converted to the model's OWN declared volume unit. Federated
 *   models are converted with their own scale, not the active model's.
 *
 * ## Why this bypasses the per-mutation store actions
 *
 * `createPropertySet` copies the model's whole undo stack on every call, so
 * driving it once per element is quadratic - 10k elements would copy ~10k-entry
 * arrays 20k times. This writes straight to each model's `MutablePropertyView`
 * (the same object those actions write to) and then commits ONE store update.
 * The trade is that the run does not enter the undo stack, which is the same
 * trade `BulkPropertyEditor` already makes for the same reason; the inverse is
 * an explicit "remove" action rather than 20k presses of Ctrl+Z.
 *
 * The collab role gate those actions carry is NOT skipped - it is checked once,
 * up front, for the whole run.
 */

import { useCallback } from 'react';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { QuantityType, PropertyValueType } from '@ifc-lite/data';
import { extractProjectUnits, type IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { resolveEntityRef } from '@/store/resolveEntityRef';
import { configureMutationView } from '@/utils/configureMutationView';
import {
  buildElementWriteBack,
  summarize,
  declaredVolumeBases,
  validEntry,
  zonePropertySetName,
  zoneQuantitySetPrefix,
  ZONE_QUANTITY_SET_NAME_PREFIX,
  type ElementWriteBack,
  type ElementZoneFacts,
  type VolumeBasis,
  type WriteBackRefusal,
  type WriteBackSummary,
  type ZoneSet,
} from '@/lib/zones';
import { computeZoneApportionmentNow, gatherProvedVolumes, type ProvedVolumes } from './useZoneApportionment.js';

export interface ZoneWriteBackResult {
  summary: WriteBackSummary;
  /** Model ids that gained properties. */
  modelIds: string[];
  elapsedMs: number;
  /** Set when nothing was written because the session forbids editing. */
  blocked: 'collab-role' | null;
}

const EMPTY: ZoneWriteBackResult = {
  summary: { written: 0, withVolumes: 0, refused: 0, skippedNoZone: 0 },
  modelIds: [],
  elapsedMs: 0,
  blocked: null,
};

/** Per-model things the loop would otherwise re-derive per element. */
interface ModelContext {
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
function contextFor(modelId: string, cache: Map<string, ModelContext | null>): ModelContext | null {
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
function quantitySetsFor(context: ModelContext, expressId: number) {
  return context.view.getQuantitiesForEntity(expressId);
}

/** Resolve the whole-element total on `basis`, plus the quantity name it came
 *  from. `null` total means the file declares nothing on that basis. */
function declaredTotal(
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

interface VolumeResolution {
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
function resolveVolumes(
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

/**
 * Write `zoneSet`'s assignment into every model it reaches.
 *
 * Recomputes the apportionment first when the cache is stale, so the file can
 * never carry volumes from zones that have since moved.
 */
export function applyZoneWriteBack(zoneSet: ZoneSet, basis: VolumeBasis): ZoneWriteBackResult {
  const state = useViewerStore.getState();
  // Checked ONCE for the run rather than per element, which is the only
  // difference from the per-mutation actions' own gate: a read-only collab
  // participant must not accumulate local edits no peer will ever see.
  if (!state.canCollabEdit()) return { ...EMPTY, blocked: 'collab-role' };

  const t0 = performance.now();
  const zoneNameById = new Map(zoneSet.zones.map((z) => [z.id, z.name]));
  const apportioned = validEntry(state.zoneApportionment, zoneSet) ?? computeZoneApportionmentNow(zoneSet);
  const proved = gatherProvedVolumes();

  const contexts = new Map<string, ModelContext | null>();
  const results: Array<ElementWriteBack | null> = [];
  const touchedModels = new Set<string>();

  for (const [globalId, record] of state.zoneAssignments) {
    const assignment = record[zoneSet.id];
    if (!assignment || assignment.touchedZoneIds.length === 0) {
      results.push(null);
      continue;
    }
    const ref = resolveEntityRef(globalId);
    const context = contextFor(ref.modelId, contexts);
    if (!context) {
      results.push(null);
      continue;
    }

    // ONE read of the entity's quantity sets per element, serving both the
    // declared basis and the stale-zone-qset sweep below. Each read is an
    // on-demand extraction, so asking twice would double the run's cost.
    const qsets = quantitySetsFor(context, ref.expressId);
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
    const facts: ElementZoneFacts = {
      globalId,
      homeZoneName: assignment.zoneName,
      // Mapped through the set rather than trusting stored names: the
      // assignment holds zone IDS precisely so a rename cannot leave stale
      // names behind (types.ts).
      touchedZoneNames: assignment.touchedZoneIds.map((id) => zoneNameById.get(id) ?? ''),
      straddles: assignment.straddles,
      ...volumes,
    };
    const built = buildElementWriteBack(facts, {
      zoneSetName: zoneSet.name,
      basis,
      volumeSiScale: context.volumeSiScale,
    });
    results.push(built);
    if (!built) continue;

    context.view.createPropertySet(
      ref.expressId,
      built.psetName,
      built.properties.map((p) => ({
        name: p.name,
        value: p.value,
        type: p.kind === 'BOOLEAN' ? PropertyValueType.Boolean : PropertyValueType.Label,
      })),
    );
    if (built.qsetName) {
      context.view.createQuantitySet(
        ref.expressId,
        built.qsetName,
        built.quantities.map((q) => ({ name: q.name, value: q.value, quantityType: QuantityType.Volume })),
      );
    }
    // Whatever a previous run left on this element for this zone set, under a
    // different basis or under this one when the volume is now refused, is
    // removed. Otherwise switching basis accumulates one quantity set per basis
    // ever chosen, and a re-run that refuses leaves stale numbers standing
    // beside a property saying no volume could be computed.
    const scope = zoneQuantitySetPrefix(zoneSet.name);
    for (const q of qsets) {
      if (q.name.startsWith(scope) && q.name !== built.qsetName) {
        context.view.deleteQuantitySet(ref.expressId, q.name);
      }
    }
    touchedModels.add(ref.modelId);
  }

  const modelIds = [...touchedModels];
  if (modelIds.length > 0) useViewerStore.getState().markModelsDirty(modelIds);
  return {
    summary: summarize(results),
    modelIds,
    elapsedMs: performance.now() - t0,
    blocked: null,
  };
}

/**
 * Remove what a previous run wrote, for one zone set.
 *
 * The inverse exists because the run does not enter the undo stack (see the
 * module doc). It deletes by NAME, so it also clears sets written in an earlier
 * session and re-imported, and it clears the quantity set on EVERY basis rather
 * than only the one currently selected in the panel.
 */
export function removeZoneWriteBack(zoneSet: ZoneSet): { removed: number; modelIds: string[] } {
  const state = useViewerStore.getState();
  if (!state.canCollabEdit()) return { removed: 0, modelIds: [] };
  const psetName = zonePropertySetName(zoneSet.name);
  const scope = zoneQuantitySetPrefix(zoneSet.name);
  const contexts = new Map<string, ModelContext | null>();
  const touchedModels = new Set<string>();
  let removed = 0;

  for (const [globalId, record] of state.zoneAssignments) {
    const assignment = record[zoneSet.id];
    if (!assignment || assignment.touchedZoneIds.length === 0) continue;
    const ref = resolveEntityRef(globalId);
    const context = contextFor(ref.modelId, contexts);
    if (!context) continue;
    context.view.deletePropertySet(ref.expressId, psetName);
    for (const q of context.view.getQuantitiesForEntity(ref.expressId)) {
      if (q.name.startsWith(scope)) context.view.deleteQuantitySet(ref.expressId, q.name);
    }
    touchedModels.add(ref.modelId);
    removed++;
  }

  const modelIds = [...touchedModels];
  if (modelIds.length > 0) useViewerStore.getState().markModelsDirty(modelIds);
  return { removed, modelIds };
}

/** React-facing handles. */
export function useZoneWriteBack() {
  const write = useCallback((zoneSet: ZoneSet, basis: VolumeBasis) => applyZoneWriteBack(zoneSet, basis), []);
  const remove = useCallback((zoneSet: ZoneSet) => removeZoneWriteBack(zoneSet), []);
  return { write, remove };
}
