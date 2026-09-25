/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Copy-on-write for property and quantity sets an edit reaches through a
 * SHARED `IfcRelDefinesByProperties` (#5794).
 *
 * Authoring tools routinely relate one `IfcPropertySet` to many elements
 * through one relation. The viewer edits ONE element's properties, so the
 * export must change that element only: it gets its own regenerated set and
 * its own relation (the generators already write both), it leaves the shared
 * relation's `RelatedObjects`, and every other element keeps the original
 * set, byte for byte. The relation and the set are withheld only when no
 * surviving element is left on them.
 *
 * The regenerated copy references the source member atom of every property
 * the session did not edit instead of re-serializing it as a single value, so
 * list, enumerated, bounded, table, reference and complex members keep their
 * IFC class. IFC allows the sharing: `IfcProperty.PartOfPset` is
 * `SET [0:?]` in IFC4/IFC4X3, and IFC2X3 declares no such inverse.
 */

import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { ExportPass } from './step-export-types.js';
import { filterHiddenRefsFromRelationshipLine } from './reference-collector.js';
import { type PropertySetContext, getPropertyIdsInSet } from './step-property-set-readers.js';

/** The shared relations one collection pass has detached elements from. */
export class SharedRelationDetachments {
  private readonly byRel = new Map<number, { setId: number; detached: Set<number> }>();

  /** `entityId` gets its own copy of the set `relId` relates it to. */
  detach(relId: number, setId: number, entityId: number): void {
    let entry = this.byRel.get(relId);
    if (!entry) {
      entry = { setId, detached: new Set() };
      this.byRel.set(relId, entry);
    }
    entry.detached.add(entityId);
  }

  /**
   * Decide, once every edit is collected, what each touched relation becomes.
   * A relation that still relates a live element is narrowed at write time
   * (`pass.detachedRelatedObjects`) and keeps its set and members. One left
   * with nobody is withheld with its set and member atoms, as before #5794;
   * `retainSharedAtoms` still rescues an atom another set names.
   */
  settle(pass: ExportPass, ctx: PropertySetContext, relatedByRel: ReadonlyMap<number, readonly number[]>): void {
    for (const [relId, { setId, detached }] of this.byRel) {
      const related = relatedByRel.get(relId) ?? [];
      const stays = related.some((id) => !detached.has(id) && !pass.effective.isDeleted(id));
      if (stays) {
        pass.detachedRelatedObjects.set(relId, detached);
        continue;
      }
      pass.skipRelationshipIds.add(relId);
      pass.skipPropertySetIds.add(setId);
      for (const memberId of getPropertyIdsInSet(ctx, setId)) pass.skipPropertySetIds.add(memberId);
    }
  }
}

/**
 * Property name → source member atom id, for every member of `setId` whose
 * property the session left unedited on `entityId`. The first member wins a
 * duplicated name, matching what the base property read shows.
 */
export function unmodifiedSourceMembers(
  ctx: PropertySetContext,
  view: MutablePropertyView,
  entityId: number,
  setName: string,
  setId: number,
): Map<string, number> {
  const members = new Map<string, number>();
  const extractor = ctx.entityExtractor;
  if (!extractor || typeof view.getPropertyMutation !== 'function') return members;
  for (const memberId of getPropertyIdsInSet(ctx, setId)) {
    // @raw-entity-enumeration-ok point lookup for a source member's decoded Name
    const ref = ctx.dataStore.entityIndex.byId.get(memberId);
    if (!ref || !ctx.isReadableSourceRef(ref)) continue;
    const name = extractor.extractEntity(ref)?.attributes[0];
    if (typeof name !== 'string' || members.has(name)) continue;
    if (view.getPropertyMutation(entityId, setName, name) !== undefined) continue;
    members.set(name, memberId);
  }
  return members;
}

/**
 * Keep every member atom a regenerated copy references. Runs after all skip
 * decisions: an atom deduplicated across sets can be withheld by a different
 * edit, and the copy would then name a line nobody wrote.
 */
export function retainReusedSourceMembers(pass: ExportPass): void {
  for (const { sourceMembers } of pass.newPropertySets) {
    for (const members of sourceMembers?.values() ?? []) {
      for (const memberId of members.values()) pass.skipPropertySetIds.delete(memberId);
    }
  }
}

/**
 * Take the elements that got their own copy out of a shared relation's
 * `RelatedObjects`. `null` when nothing would remain, which `settle` rules out
 * for the effective relation; the caller withholds the line in that case.
 */
export function detachRelatedObjects(pass: ExportPass, relId: number, line: string): string | null {
  const detached = pass.detachedRelatedObjects.get(relId);
  if (!detached) return line;
  return filterHiddenRefsFromRelationshipLine(line, (id) => detached.has(id));
}
