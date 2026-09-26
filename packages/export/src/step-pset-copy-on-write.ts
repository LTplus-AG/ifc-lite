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
 * A type object's own set (`HasPropertySets`) follows the same rule: another
 * type object naming the same set keeps it.
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
import {
  type PropertySetContext,
  getPropertyIdsInSet,
  getTypeOwnedHasPropertySetIds,
} from './step-property-set-readers.js';
import { isTypeClass } from './type-owned-psets.js';
import { isOmittedFromPassOutput } from './step-omission-predicates.js';

/** What `settle` reads to tell whether anything else still names a set. */
export interface RelationIndex {
  /** Every effective IfcRelDefinesByProperties → its RelatedObjects. */
  readonly relatedByRel: ReadonlyMap<number, readonly number[]>;
  /** Element → the relations (and their set) that relate it. */
  readonly relDefinesByEntity: ReadonlyMap<number, ReadonlyArray<{ relId: number; psetId: number }>>;
}

/**
 * The shared sets one collection pass has taken an edited owner off: a
 * relation's related element, or a type object's `HasPropertySets` entry.
 */
export class SharedSetDetachments {
  private readonly byRel = new Map<number, { setId: number; detached: Set<number> }>();
  /** Type-owned set id → the type objects whose own copy replaces it. */
  private readonly typeOwned = new Map<number, Set<number>>();

  /** `entityId` gets its own copy of the set `relId` relates it to. */
  detach(relId: number, setId: number, entityId: number): void {
    let entry = this.byRel.get(relId);
    if (!entry) {
      entry = { setId, detached: new Set() };
      this.byRel.set(relId, entry);
    }
    entry.detached.add(entityId);
  }

  /** Type object `typeId` drops `setId` from its `HasPropertySets`. */
  withholdTypeOwned(setId: number, typeId: number): void {
    let owners = this.typeOwned.get(setId);
    if (!owners) {
      owners = new Set();
      this.typeOwned.set(setId, owners);
    }
    owners.add(typeId);
  }

  /**
   * Decide, once every edit is collected, what each touched set becomes. A
   * relation that still relates an element this export writes is narrowed at write time
   * (`pass.detachedRelatedObjects`) and keeps its set and members; so does a
   * type-owned set another type object or a surviving relation still names.
   * Anything left with nobody is withheld with its member atoms, as before
   * #5794; `retainSharedAtoms` still rescues an atom another set names.
   */
  settle(pass: ExportPass, ctx: PropertySetContext, index: RelationIndex): void {
    // The export filter's own predicate: an owner that is deleted, hidden or
    // unwritable keeps nothing, or a kept set's relation would be narrowed to
    // nobody at write time and the set shipped as an orphan.
    const survives = (id: number): boolean => !isOmittedFromPassOutput(pass, id);
    const withhold = (setId: number): void => {
      pass.skipPropertySetIds.add(setId);
      for (const memberId of getPropertyIdsInSet(ctx, setId)) pass.skipPropertySetIds.add(memberId);
    };
    const keptByRelation = new Set<number>();
    const touchedSetByRel = new Map<number, number>();
    for (const [relId, { setId, detached }] of this.byRel) {
      touchedSetByRel.set(relId, setId);
      const related = index.relatedByRel.get(relId) ?? [];
      if (related.some((id) => !detached.has(id) && survives(id))) {
        pass.detachedRelatedObjects.set(relId, detached);
        keptByRelation.add(setId);
        continue;
      }
      pass.skipRelationshipIds.add(relId);
      withhold(setId);
    }
    if (this.typeOwned.size === 0) return;

    // Only paid for when a type object's own set was edited: every other
    // owner of those sets, among live type objects and live relations.
    const stillNamed = new Set(keptByRelation);
    for (const [entityId, rels] of index.relDefinesByEntity) {
      if (!survives(entityId)) continue;
      for (const { relId, psetId } of rels) {
        if (touchedSetByRel.has(relId) || !this.typeOwned.has(psetId)) continue;
        if (!pass.skipRelationshipIds.has(relId)) stillNamed.add(psetId);
      }
    }
    for (const [type, ids] of pass.effective.byType) {
      if (!isTypeClass(type.toUpperCase())) continue;
      for (const typeId of ids) {
        if (!survives(typeId)) continue;
        for (const setId of getTypeOwnedHasPropertySetIds(ctx, typeId, pass.effective)) {
          if (this.typeOwned.get(setId)?.has(typeId) === false) stillNamed.add(setId);
        }
      }
    }
    for (const setId of this.typeOwned.keys()) {
      if (!stillNamed.has(setId)) withhold(setId);
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
