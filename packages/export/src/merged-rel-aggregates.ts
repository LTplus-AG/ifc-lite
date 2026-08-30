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
 * RelatingObject (attr 4) AND ALL its RelatedObjects (attr 5) were
 * remapped via sharedRemap. When only the RelatingObject and SOME (not
 * all) of its RelatedObjects were remapped — e.g. Model2's Building
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

    const remappedRefs = refs.filter(ref => sharedRemap.has(ref));
    if (remappedRefs.length === refs.length) {
      // ALL related objects were also remapped — this rel is fully redundant.
      skipEntityIds.add(relId);
    } else if (remappedRefs.length > 0) {
      // Some, not all — keep the rel for its new member(s), but drop the
      // ones Model1's own relationship already aggregates.
      relAggregateStrip.set(relId, new Set(remappedRefs));
    }
  }
}

/**
 * Render-time counterpart of {@link skipRedundantRelAggregates}: drop
 * RelatedObjects members a partially redundant IFCRELAGGREGATES already
 * shares with the first model's OWN relationship to the same (now-unified)
 * RelatingObject. Reuses the same list/scalar-aware ref filter the
 * `visibleOnly`/deletion dangling-ref path uses; the strip set never
 * includes the RelatingObject's own id (only RelatedObjects members), so
 * this can only narrow the list, never null out the whole line. Must run in
 * LOCAL id space, before any id offset/remap — `localId` and the ids inside
 * `relAggregateStrip` are both local to the model being rendered.
 *
 * Returns `entityText` unchanged when `localId` has no strip entry.
 */
export function applyRelAggregateStrip(
  entityText: string,
  localId: number,
  relAggregateStrip: ReadonlyMap<number, ReadonlySet<number>>,
): string {
  const toStrip = relAggregateStrip.get(localId);
  if (toStrip === undefined) return entityText;
  const filtered = filterHiddenRefsFromRelationshipLine(entityText, id => toStrip.has(id));
  return filtered !== null ? filtered : entityText;
}
