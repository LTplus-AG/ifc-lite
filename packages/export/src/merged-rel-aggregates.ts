/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Partial-redundancy bookkeeping for IFCRELAGGREGATES during a merge.
 *
 * Split out of {@link ../merged-exporter.ts} (kept under its module-size
 * budget) rather than duplicated: `findEntitiesByType`/`extractStepAttribute`
 * stay the single source of truth in `MergedExporter` and are passed in here,
 * so this file has no data-model logic of its own to drift from it.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import { filterHiddenRefsFromRelationshipLine } from './reference-collector.js';

/**
 * Skip IfcRelAggregates that become fully redundant after unification, and
 * mark the individually-redundant members of ones only PARTIALLY so for
 * stripping.
 *
 * An object has at most one aggregation parent: `IfcObjectDefinition.Decomposes`
 * is `SET [0:1]`, and `IfcSpatialStructureElement.WR41` requires exactly one
 * for a building or storey. Once a later model's Building unifies with the
 * primary's, the primary's own `IfcRelAggregates` already gives it a parent,
 * so a later model's rel naming the same (remapped) Building gives it a second
 * one. That holds whether the later rel's RelatingObject remaps to the same
 * parent (the duplicate-edge case, e.g. `(Project, (Site))` twice) or to a
 * different one (#5471: model B aggregates its Building directly under its
 * Project, model A under a Site, so A's Building ends up under both).
 *
 * So a RelatedObjects member is redundant when its final id is already in
 * `aggregatedObjects`, the set of final ids that already have a parent in the
 * output. A rel whose members are ALL redundant is skipped outright; one with
 * SOME redundant members is kept for its new member(s), and the redundant ids
 * are recorded in `relAggregateStrip` so {@link applyRelAggregateStrip} drops
 * them from the emitted list. A unified member with no parent yet is kept: that
 * rel is then the only statement of its parentage (#3550).
 *
 * `aggregatedObjects` is seeded from the primary model by
 * {@link collectAggregatedObjects} and extended here with every member a kept
 * rel emits, so a third model cannot give an object a parent the second already
 * did. `sharedRemap` must already hold every unification of this model
 * (spatial, infrastructure AND GlobalId), because a member remapped only
 * later would be missed. `idOffset` places this model's unremapped ids in
 * final id space.
 */
export function skipRedundantRelAggregates(
  dataStore: IfcDataStore,
  sharedRemap: ReadonlyMap<number, number>,
  idOffset: number,
  skipEntityIds: Set<number>,
  relAggregateStrip: Map<number, Set<number>>,
  aggregatedObjects: Set<number>,
  findEntitiesByType: (dataStore: IfcDataStore, typeUpper: string) => number[],
  extractStepAttribute: (expressId: number, dataStore: IfcDataStore, attrIndex: number) => string | null,
): void {
  for (const relId of findEntitiesByType(dataStore, 'IFCRELAGGREGATES')) {
    // RelatedObjects is attr 5 — list of #refs like (#2,#3)
    const refs = listRefs(extractStepAttribute(relId, dataStore, 5));
    if (refs.length === 0) continue;

    const finalId = (ref: number) => sharedRemap.get(ref) ?? ref + idOffset;
    const redundantRefs = refs.filter(ref => aggregatedObjects.has(finalId(ref)));
    if (redundantRefs.length === refs.length) {
      // Every member already has a parent in the output — fully redundant.
      skipEntityIds.add(relId);
      continue;
    }
    if (redundantRefs.length > 0) {
      // Some, not all — keep the rel for its new member(s), but drop the
      // ones that already have a parent.
      relAggregateStrip.set(relId, new Set(redundantRefs));
    }
    for (const ref of refs) aggregatedObjects.add(finalId(ref));
  }
}

/** The `#id`s in one STEP list attribute, in order; `[]` for a missing one. */
function listRefs(attr: string | null): number[] {
  if (!attr) return [];
  const refs: number[] = [];
  const refRegex = /#(\d+)/g;
  let match: RegExpExecArray | null;
  while ((match = refRegex.exec(attr)) !== null) refs.push(parseInt(match[1], 10));
  return refs;
}

/**
 * The final ids of every object the primary model aggregates under a parent,
 * i.e. every IfcRelAggregates RelatedObjects member, offset into final id
 * space. Seeds {@link skipRedundantRelAggregates}'s `aggregatedObjects`.
 */
export function collectAggregatedObjects(
  dataStore: IfcDataStore,
  findEntitiesByType: (dataStore: IfcDataStore, typeUpper: string) => number[],
  extractStepAttribute: (expressId: number, dataStore: IfcDataStore, attrIndex: number) => string | null,
  idOffset: number,
): Set<number> {
  const aggregated = new Set<number>();
  for (const relId of findEntitiesByType(dataStore, 'IFCRELAGGREGATES')) {
    for (const ref of listRefs(extractStepAttribute(relId, dataStore, 5))) aggregated.add(ref + idOffset);
  }
  return aggregated;
}

/**
 * Render-time counterpart of {@link skipRedundantRelAggregates}: drop
 * RelatedObjects members a partially redundant IFCRELAGGREGATES already
 * shares with the first model's OWN relationship to the same (now-unified)
 * RelatingObject. Reuses the same list/scalar-aware ref filter the
 * `visibleOnly`/deletion dangling-ref path uses. Must run in LOCAL id
 * space, before any id offset/remap — `localId` and the ids inside
 * `relAggregateStrip` are both local to the model being rendered.
 *
 * Returns `entityText` unchanged when `localId` has no strip entry, and
 * `null` when the filter would withhold the whole line — a strip set built
 * by {@link skipRedundantRelAggregates} is a strict subset of the
 * RelatedObjects list, so for well-formed input the filter only narrows,
 * but a degenerate file (a stripped member id that also appears as a
 * single-valued ref, e.g. self-aggregation) can null the line. The caller
 * must withhold it, like every other user of the filter: every edge the
 * line declared is already declared by the primary model, and emitting the
 * unfiltered bytes instead would reintroduce the duplicate membership this
 * module exists to remove.
 */
export function applyRelAggregateStrip(
  entityText: string,
  localId: number,
  relAggregateStrip: ReadonlyMap<number, ReadonlySet<number>>,
): string | null {
  const toStrip = relAggregateStrip.get(localId);
  if (toStrip === undefined) return entityText;
  return filterHiddenRefsFromRelationshipLine(entityText, id => toStrip.has(id));
}
