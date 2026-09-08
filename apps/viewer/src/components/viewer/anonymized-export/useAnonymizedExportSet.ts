/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `useAnonymizedExportSet` — turns the viewer's current selection into an
 * "anonymized isolated export" candidate set (#2934): resolve the seeds,
 * pick the one model this export targets, expand by relationship context via
 * `collectRelatedEntities` (`@ifc-lite/export`), and let the dialog exclude
 * individual related entities before export.
 *
 * Seeds are LATCHED on the transition to `active` (dialog open), not read
 * live — reading `selectedEntityIds` live would silently re-seed under the
 * dialog every time the user clicked something else in the 3D view while it
 * was open. `reload()` re-latches on demand ("Reload from selection").
 *
 * Ids resolve through `resolveEntityRef` (never offset arithmetic — see
 * `apps/viewer/AGENTS.md` "Selection has two channels" and the root
 * AGENTS.md federation rules) and only ever expand within ONE model: an
 * anonymized export reproduces a bug in a single source file, so a seed
 * selected in a different model is reported via `otherModelSeedCount`
 * rather than silently dropped or merged in.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { collectRelatedEntities, type RelatedEntities, type RelatedEntityOptions } from '@ifc-lite/export';
import { useViewerStore, resolveEntityRef } from '@/store';
import type { EntityRef, FederatedModel } from '@/store';

/** (relationship, role) pairs that make an id part of the ALWAYS-included
 *  spatial containment chain — never individually excludable, matching the
 *  locked "Spatial containers" row in the dialog. */
const LOCKED_GROUP_KEYS = new Set([
  'IfcRelContainedInSpatialStructure|container',
  'IfcRelAggregates|spatial ancestor',
]);

export interface AnonymizedExportSetResult {
  /** The model this export targets — the model of the primary selection, or
   *  (when that is unset) whichever model contributed the most seeds. */
  targetModelId: string | null;
  targetModel: FederatedModel | null;
  /** Latched seed express ids, local to `targetModel`, deduped. */
  seeds: number[];
  /** How many of the latched selection's ids resolved to a DIFFERENT model
   *  than `targetModelId` — shown as a warning, never silently expanded. */
  otherModelSeedCount: number;
  /** How many latched seeds were dropped because they are overlay-created
   *  (`StoreEditor`-added) entities with no STEP source record — this export
   *  reads and rewrites source records, so such a seed cannot be included. */
  droppedOverlaySeedCount: number;
  /** Current `RelatedEntityOptions` toggle state. */
  options: RelatedEntityOptions;
  /** Merge a partial patch into `options`. */
  setOption: (patch: Partial<RelatedEntityOptions>) => void;
  /** The latest `collectRelatedEntities` result, or `null` before there are
   *  any seeds to expand. */
  related: RelatedEntities | null;
  /** Ids the user has explicitly unchecked from an otherwise-included group.
   *  Never contains a seed or a locked spatial-container id. */
  excludedIds: ReadonlySet<number>;
  /** Ids that can never be excluded (seeds + the locked spatial chain). */
  lockedIds: ReadonlySet<number>;
  /** Include/exclude one related id. A no-op for a locked id. */
  setExcluded: (id: number, excluded: boolean) => void;
  /** Every non-relationship IFC class in `related.all` with how many of its
   *  entities the set holds — the "what am I about to export" overview.
   *  `locked` = every entity of the class is locked (e.g. `IfcProject`), so
   *  excluding it would change nothing. Sorted by count desc, then name. */
  typeCategories: ReadonlyArray<TypeCategory>;
  /** IFC classes (PascalCase, e.g. `IfcSpace`) the user blocked wholesale. */
  excludedTypes: ReadonlySet<string>;
  /** Block/unblock a whole class regardless of how its entities were reached.
   *  Locked ids (seeds + spatial chain) are never removed by this. */
  setTypeExcluded: (typeName: string, excluded: boolean) => void;
  /** `related.all` minus `excludedIds` minus unlocked members of
   *  `excludedTypes` — what actually gets exported. */
  includedIds: ReadonlySet<number>;
  /** Re-latch seeds from the CURRENT `selectedEntityIds` and clear exclusions. */
  reload: () => void;
  /** `true` once at least one seed latched into `targetModel`. */
  hasSelection: boolean;
}

export interface TypeCategory {
  /** PascalCase IFC class name (`store.entities.getTypeName`). */
  typeName: string;
  count: number;
  excluded: boolean;
  locked: boolean;
}

interface PriorVisibilitySnapshot {
  ref: EntityRef;
  globalId: number;
}

/**
 * @param active Whether the owning dialog is open. Seeds latch on the
 *   transition from `false` to `true`.
 */
export function useAnonymizedExportSet(active: boolean): AnonymizedExportSetResult {
  const models = useViewerStore((s) => s.models);
  const selectedEntity = useViewerStore((s) => s.selectedEntity);
  const selectedEntityIds = useViewerStore((s) => s.selectedEntityIds);
  const getMutationView = useViewerStore((s) => s.getMutationView);

  const [latched, setLatched] = useState<PriorVisibilitySnapshot[]>([]);
  const [options, setOptions] = useState<RelatedEntityOptions>({});
  const [excludedIds, setExcludedIds] = useState<ReadonlySet<number>>(new Set());
  const [excludedTypes, setExcludedTypes] = useState<ReadonlySet<string>>(new Set());

  const latchFromSelection = useCallback(() => {
    const entries: PriorVisibilitySnapshot[] = [];
    for (const globalId of selectedEntityIds) {
      entries.push({ globalId, ref: resolveEntityRef(globalId) });
    }
    setLatched(entries);
    setExcludedIds(new Set());
    setExcludedTypes(new Set());
  }, [selectedEntityIds]);

  const wasActiveRef = useRef(false);
  useEffect(() => {
    if (active && !wasActiveRef.current) {
      latchFromSelection();
    }
    wasActiveRef.current = active;
  }, [active, latchFromSelection]);

  const byModel = useMemo(() => {
    const m = new Map<string, PriorVisibilitySnapshot[]>();
    for (const entry of latched) {
      const arr = m.get(entry.ref.modelId);
      if (arr) arr.push(entry);
      else m.set(entry.ref.modelId, [entry]);
    }
    return m;
  }, [latched]);

  const targetModelId = useMemo(() => {
    if (selectedEntity && byModel.has(selectedEntity.modelId)) return selectedEntity.modelId;
    let best: string | null = null;
    let bestCount = -1;
    for (const [modelId, entries] of byModel) {
      if (entries.length > bestCount) {
        best = modelId;
        bestCount = entries.length;
      }
    }
    return best;
  }, [selectedEntity, byModel]);

  const targetModel = targetModelId ? models.get(targetModelId) ?? null : null;

  const otherModelSeedCount = latched.length - (targetModelId ? byModel.get(targetModelId)?.length ?? 0 : 0);

  const { seeds, droppedOverlaySeedCount } = useMemo(() => {
    if (!targetModelId) return { seeds: [] as number[], droppedOverlaySeedCount: 0 };
    const entries = byModel.get(targetModelId) ?? [];
    const mutationView = getMutationView(targetModelId);
    const seen = new Set<number>();
    const kept: number[] = [];
    let dropped = 0;
    for (const { ref } of entries) {
      if (seen.has(ref.expressId)) continue;
      seen.add(ref.expressId);
      if (mutationView?.getNewEntity(ref.expressId)) {
        dropped++;
        continue;
      }
      kept.push(ref.expressId);
    }
    return { seeds: kept, droppedOverlaySeedCount: dropped };
  }, [targetModelId, byModel, getMutationView]);

  const related = useMemo(() => {
    if (!targetModel?.ifcDataStore || seeds.length === 0) return null;
    return collectRelatedEntities(targetModel.ifcDataStore, seeds, options);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `options` is a plain object recreated on every setOption; its own identity is the intended dependency, not a deep-equality trap
  }, [targetModel, seeds, options]);

  const lockedIds = useMemo(() => {
    const locked = new Set<number>(seeds);
    if (!related) return locked;
    for (const group of related.groups) {
      if (!LOCKED_GROUP_KEYS.has(`${group.relationship}|${group.role}`)) continue;
      for (const id of group.expressIds) locked.add(id);
      for (const id of group.relationshipIds) locked.add(id);
    }
    return locked;
  }, [related, seeds]);

  // Prune exclusions that no longer apply: an id dropped from the related set
  // by a toggle, or an id that BECAME locked (e.g. also reached via the
  // spatial chain), cannot stay in the exclusion set.
  useEffect(() => {
    setExcludedIds((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Set<number>();
      for (const id of prev) {
        if (related && related.all.has(id) && !lockedIds.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [related, lockedIds]);

  const setExcluded = useCallback((id: number, excluded: boolean) => {
    setExcludedIds((prev) => {
      if (lockedIds.has(id)) return prev;
      const has = prev.has(id);
      if (excluded === has) return prev;
      const next = new Set(prev);
      if (excluded) next.add(id);
      else next.delete(id);
      return next;
    });
  }, [lockedIds]);

  // PascalCase class per related id; `IfcRel*` entities are plumbing the
  // exporter prunes on its own, not a category a user reasons about.
  const typeOfId = useMemo(() => {
    const m = new Map<number, string>();
    const store = targetModel?.ifcDataStore;
    if (!related || !store) return m;
    for (const id of related.all) {
      const name = store.entities.getTypeName(id);
      if (!name.startsWith('IfcRel')) m.set(id, name);
    }
    return m;
  }, [related, targetModel]);

  const typeCategories = useMemo<TypeCategory[]>(() => {
    const counts = new Map<string, { count: number; unlocked: number }>();
    for (const [id, typeName] of typeOfId) {
      const c = counts.get(typeName) ?? { count: 0, unlocked: 0 };
      c.count++;
      if (!lockedIds.has(id)) c.unlocked++;
      counts.set(typeName, c);
    }
    return [...counts]
      .map(([typeName, c]) => ({
        typeName,
        count: c.count,
        excluded: excludedTypes.has(typeName),
        locked: c.unlocked === 0,
      }))
      .sort((a, b) => b.count - a.count || a.typeName.localeCompare(b.typeName));
  }, [typeOfId, lockedIds, excludedTypes]);

  const setTypeExcluded = useCallback((typeName: string, excluded: boolean) => {
    setExcludedTypes((prev) => {
      if (prev.has(typeName) === excluded) return prev;
      const next = new Set(prev);
      if (excluded) next.add(typeName);
      else next.delete(typeName);
      return next;
    });
  }, []);

  const includedIds = useMemo(() => {
    if (!related) return new Set<number>();
    const out = new Set<number>();
    for (const id of related.all) {
      if (excludedIds.has(id)) continue;
      const typeName = typeOfId.get(id);
      if (typeName !== undefined && excludedTypes.has(typeName) && !lockedIds.has(id)) continue;
      out.add(id);
    }
    return out;
  }, [related, excludedIds, excludedTypes, typeOfId, lockedIds]);

  const setOption = useCallback((patch: Partial<RelatedEntityOptions>) => {
    setOptions((prev) => ({ ...prev, ...patch }));
  }, []);

  return {
    targetModelId,
    targetModel,
    seeds,
    otherModelSeedCount: Math.max(0, otherModelSeedCount),
    droppedOverlaySeedCount,
    options,
    setOption,
    related,
    excludedIds,
    lockedIds,
    setExcluded,
    typeCategories,
    excludedTypes,
    setTypeExcluded,
    includedIds,
    reload: latchFromSelection,
    hasSelection: seeds.length > 0,
  };
}
