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
 * Skip IfcRelAggregates that become fully redundant after spatial
 * unification, and mark the individually-redundant members of ones only
 * PARTIALLY so for stripping.
 *
 * When Model2's `IfcRelAggregates(Project, (Site))` gets remapped to
 * `IfcRelAggregates(FirstProject, (FirstSite))`, it duplicates Model1's
 * existing relationship, causing viewers to show Site multiple times.
 *
 * An IfcRelAggregates is fully redundant (skipped entirely) when its
 * RelatingObject (attr 4) AND ALL its RelatedObjects (attr 5) remap to an
 * edge the primary model already declares. When only the RelatingObject and
 * SOME (not all) of its RelatedObjects have such a primary edge — e.g. Model2's Building
 * unifies with Model1's, and one of its two Storeys matches Model1's by
 * name while the other is new — the rel is genuinely needed for its new
 * member(s), but Model1's own relationship already lists the remapped
 * one(s) under the same (now-shared) RelatingObject: emitting them again
 * here would duplicate that membership. Those specific ids are recorded in
 * `relAggregateStrip` so {@link applyRelAggregateStrip} drops them from the
 * emitted RelatedObjects list, keeping only the genuinely new members.
 */
export function skipRedundantRelAggregates(
  dataStore: IfcDataStore,
  sharedRemap: Map<number, number>,
  skipEntityIds: Set<number>,
  relAggregateStrip: Map<number, Set<number>>,
  primaryAggregatePairs: ReadonlySet<string>,
  findEntitiesByType: (dataStore: IfcDataStore, typeUpper: string) => number[],
  extractStepAttribute: (expressId: number, dataStore: IfcDataStore, attrIndex: number) => string | null,
): void {
  for (const relId of findEntitiesByType(dataStore, 'IFCRELAGGREGATES')) {
    // RelatingObject is attr 4 — single #ref
    const relatingAttr = extractStepAttribute(relId, dataStore, 4);
    if (!relatingAttr) continue;
    const relatingRef = relatingAttr.match(/^#(\d+)$/);
    if (!relatingRef || !sharedRemap.has(parseInt(relatingRef[1], 10))) continue;

    // RelatedObjects is attr 5 — list of #refs like (#2,#3)
    const relatedAttr = extractStepAttribute(relId, dataStore, 5);
    if (!relatedAttr) continue;
    const refs: number[] = [];
    const refRegex = /#(\d+)/g;
    let m;
    while ((m = refRegex.exec(relatedAttr)) !== null) {
      refs.push(parseInt(m[1], 10));
    }
    if (refs.length === 0) continue;

    const remappedRelatingObject = sharedRemap.get(parseInt(relatingRef[1], 10))!;
    // An object identity match alone does not prove that the primary model
    // already owns this aggregation edge. Preserve a matched member when this
    // is the only relationship that establishes its parentage (#3550).
    const redundantRefs = refs.filter(ref => {
      const remappedRef = sharedRemap.get(ref);
      return remappedRef !== undefined && primaryAggregatePairs.has(aggregatePairKey(remappedRelatingObject, remappedRef));
    });
    if (redundantRefs.length === refs.length) {
      // Every edge already exists in the primary model — this rel is fully redundant.
      skipEntityIds.add(relId);
    } else if (redundantRefs.length > 0) {
      // Some, not all — keep the rel for its new member(s), but drop the
      // ones Model1's own relationship already aggregates.
      relAggregateStrip.set(relId, new Set(redundantRefs));
    }
  }
}

/** Encode one `RelatingObject → RelatedObject` aggregation edge for set lookup. */
export function aggregatePairKey(relatingObjectId: number, relatedObjectId: number): string {
  return `${relatingObjectId}:${relatedObjectId}`;
}

/**
 * Collect the aggregation edges actually declared by the primary model.
 *
 * A later model may unify both endpoint entities without the primary model
 * declaring their relationship. Callers use this set to distinguish a truly
 * duplicate edge from the only surviving statement of parentage.
 */
export function collectRelAggregatePairs(
  dataStore: IfcDataStore,
  findEntitiesByType: (dataStore: IfcDataStore, typeUpper: string) => number[],
  extractStepAttribute: (expressId: number, dataStore: IfcDataStore, attrIndex: number) => string | null,
  idOffset: number,
): Set<string> {
  const pairs = new Set<string>();
  for (const relId of findEntitiesByType(dataStore, 'IFCRELAGGREGATES')) {
    const relatingAttr = extractStepAttribute(relId, dataStore, 4);
    const relatingRef = relatingAttr?.match(/^#(\d+)$/);
    if (!relatingRef) continue;
    const relatedAttr = extractStepAttribute(relId, dataStore, 5);
    if (!relatedAttr) continue;
    const relatingId = parseInt(relatingRef[1], 10) + idOffset;
    const refRegex = /#(\d+)/g;
    let match: RegExpExecArray | null;
    while ((match = refRegex.exec(relatedAttr)) !== null) {
      pairs.add(aggregatePairKey(relatingId, parseInt(match[1], 10) + idOffset));
    }
  }
  return pairs;
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
