/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where does a brand-new property/quantity go when an entity carries two base
 * sets sharing one Name (one from the type definition, one from the
 * occurrence -- see `EntityNode.property` in `packages/query/src/entity-node.ts`)?
 *
 * `propertyKey`/`quantityKey` carry no identity past the set NAME, so
 * `getForEntity`/`getQuantitiesForEntity` cannot tell the two instances apart
 * from the mutation alone. Two rules settle it, and both are needed:
 *
 *  - A member name some same-named instance ALREADY carries is not new. That
 *    mutation is an edit, and the per-member loop in each caller applies it in
 *    place on every instance that holds it. Appending it as well would put the
 *    value on an instance that never had it, so the predicate says no here for
 *    every instance, the first included.
 *  - A member name NO same-named instance carries is new. The key cannot say
 *    which instance meant it, so it goes to the first by position and nowhere
 *    else. First-by-position is the order every same-named reader in this repo
 *    walks -- `findQuantityInBaseSets`, and `@ifc-lite/query`'s
 *    `findPropertyInSets`/`findQuantityInSets`, all take the first match across
 *    the sequence -- so reading the result back resolves to the instance the
 *    write landed on.
 */

/**
 * Build the placement predicate for one entity's ordered base sets. The
 * returned `(index, memberName)` answers whether the set at `index` is the one
 * instance that takes a brand-new member of that name.
 */
export function newMemberPlacement<S extends { name: string }>(
  sets: readonly S[],
  membersOf: (set: S) => ReadonlyArray<{ name: string }>,
): (index: number, memberName: string) => boolean {
  const namesInBase = new Map<string, Set<string>>();
  const firstIndexOfName = new Map<string, number>();

  sets.forEach((set, index) => {
    if (!firstIndexOfName.has(set.name)) firstIndexOfName.set(set.name, index);
    let names = namesInBase.get(set.name);
    if (!names) {
      names = new Set<string>();
      namesInBase.set(set.name, names);
    }
    for (const member of membersOf(set)) names.add(member.name);
  });

  return (index, memberName) => {
    const set = sets[index];
    if (!set) return false;
    if (firstIndexOfName.get(set.name) !== index) return false;
    return !namesInBase.get(set.name)?.has(memberName);
  };
}
