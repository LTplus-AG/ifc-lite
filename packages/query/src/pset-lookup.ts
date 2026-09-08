/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * An IFC entity can legitimately carry two distinct property (or
 * quantity) sets that share the same name — e.g. two
 * `IfcRelDefinesByProperties` relations pointing at two different
 * "Pset_WallCommon" instances, one via the type definition and one via
 * the occurrence. A lookup that does `sets.find(s => s.name === name)`
 * only ever sees the FIRST such set: if the wanted property lives on
 * the second same-named set, it is wrongly reported missing (or, in a
 * filter, the whole entity is wrongly dropped from the result).
 *
 * These helpers implement the settled semantics (first established by
 * `PropertyTable.getProperty` in #2907, and mirrored by
 * `QueryResultEntity.getProperty`): scan EVERY set, skip ones whose
 * name doesn't match, and within the matching sets return the first
 * property/quantity whose name matches, in set order. Every reader of
 * an entity's property/quantity sets should go through these instead
 * of hand-rolling a two-step `.find`.
 */

/** Minimal shape a property/quantity needs to be matched by name. */
interface Named {
  readonly name: string;
}

/** Minimal shape a property set needs: a name and a `properties` array. */
interface PropertySetLike<P extends Named> {
  readonly name: string;
  readonly properties: readonly P[];
}

/** Minimal shape a quantity set needs: a name and a `quantities` array. */
interface QuantitySetLike<Q extends Named> {
  readonly name: string;
  readonly quantities: readonly Q[];
}

/**
 * Find a property by (setName, propName) across every property set
 * carrying that name, first match across the sequence wins. Returns
 * `undefined` when no same-named set carries a property with that name.
 */
export function findPropertyInSets<P extends Named>(
  sets: readonly PropertySetLike<P>[],
  setName: string,
  propName: string,
): P | undefined {
  for (const set of sets) {
    if (set.name !== setName) continue;
    const match = set.properties.find((p) => p.name === propName);
    if (match) return match;
  }
  return undefined;
}

/**
 * Find a quantity by (setName, quantityName) across every quantity set
 * carrying that name, first match across the sequence wins. Returns
 * `undefined` when no same-named set carries a quantity with that name.
 */
export function findQuantityInSets<Q extends Named>(
  sets: readonly QuantitySetLike<Q>[],
  setName: string,
  quantityName: string,
): Q | undefined {
  for (const set of sets) {
    if (set.name !== setName) continue;
    const match = set.quantities.find((q) => q.name === quantityName);
    if (match) return match;
  }
  return undefined;
}

/**
 * Find EVERY property named `propName`, across EVERY same-named
 * (setName) property set — not just the first. For a caller evaluating a
 * predicate ("does this entity have a set with this name and value?")
 * first-match is wrong: an entity can carry two distinct `IfcPropertySet`s
 * named e.g. "Pset_WallCommon" (one from the type, one from the
 * occurrence), and the wanted value may live on the second one. Use this
 * instead of `findPropertyInSets` when the result feeds a `.some(...)`
 * predicate rather than a single value read; keep `findPropertyInSets` for
 * value extraction (export/aggregation/display), where picking one member
 * is the documented, correct behaviour.
 */
export function findAllPropertiesInSets<P extends Named>(
  sets: readonly PropertySetLike<P>[],
  setName: string,
  propName: string,
): P[] {
  const matches: P[] = [];
  for (const set of sets) {
    if (set.name !== setName) continue;
    for (const p of set.properties) {
      if (p.name === propName) matches.push(p);
    }
  }
  return matches;
}

/**
 * Quantity counterpart to `findAllPropertiesInSets` — see its doc comment.
 */
export function findAllQuantitiesInSets<Q extends Named>(
  sets: readonly QuantitySetLike<Q>[],
  setName: string,
  quantityName: string,
): Q[] {
  const matches: Q[] = [];
  for (const set of sets) {
    if (set.name !== setName) continue;
    for (const q of set.quantities) {
      if (q.name === quantityName) matches.push(q);
    }
  }
  return matches;
}
