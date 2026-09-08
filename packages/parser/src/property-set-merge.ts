/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * How property/quantity sets coming from two different sources compose: an
 * occurrence's own sets with the ones it inherits from its `IfcTypeProduct`
 * ({@link mergeInheritedPropertySets}, {@link mergeInheritedQuantitySets}),
 * and a type's `HasPropertySets` list with the sets attached to it by
 * `IfcRelDefinesByProperties` ({@link appendSetsFromSecondSource}).
 *
 * Their own module rather than a corner of `on-demand-extractors.ts`: the rules
 * are independent of how either side was extracted, and every consumer that
 * resolves sets from more than one source needs the same answer.
 */

/**
 * Compose an occurrence's own named sets with those it inherits from its
 * `IfcTypeProduct`, the way IFC defines the inheritance: **per item (property
 * or quantity), not per set**. Shared core for {@link mergeInheritedPropertySets}
 * and {@link mergeInheritedQuantitySets} — see those for the rule this
 * implements and why.
 *
 * `getItems`/`withItems` isolate the one difference between the two: which
 * field holds the named children (`properties` vs `quantities`).
 */
function mergeInheritedNamedSets<T extends { name: string }, Item extends { name: string }>(
    ownSets: readonly T[],
    inheritedSets: readonly T[],
    getItems: (set: T) => readonly Item[],
    withItems: (set: T, items: readonly Item[]) => T,
): T[] {
    if (inheritedSets.length === 0) return ownSets.slice();

    const merged = ownSets.slice();
    const indicesByName = new Map<string, number[]>();
    for (let i = 0; i < merged.length; i++) {
        const bucket = indicesByName.get(merged[i].name);
        if (bucket) bucket.push(i);
        else indicesByName.set(merged[i].name, [i]);
    }

    for (const inherited of inheritedSets) {
        // An UNNAMED set matches nothing: since #3530 every set the source left
        // without a Name reports `''`, so keying on it would fold an unnamed
        // inherited set into an unrelated unnamed occurrence set and lose any
        // item the two happen to share. Before #3530 the two carried distinct
        // placeholder names and were kept apart here; an absent name is
        // evidence of nothing, least of all of sameness.
        const indices = inherited.name ? indicesByName.get(inherited.name) : undefined;
        if (!indices) {
            // Appended as-is, and deliberately NOT recorded in `indicesByName`:
            // that index tracks OCCURRENCE sets only. Recording it would make a
            // second inherited set of the same name fold into this one, quietly
            // collapsing two type-side sets into one — a different operation
            // from "occurrence inherits from type".
            merged.push(inherited);
            continue;
        }
        for (const index of indices) {
            const own = merged[index];
            const ownItems = getItems(own);
            const ownNames = new Set(ownItems.map((p) => p.name));
            const additions = getItems(inherited).filter((p) => !ownNames.has(p.name));
            if (additions.length === 0) continue;
            merged[index] = withItems(own, [...ownItems, ...additions]);
        }
    }

    return merged;
}

/**
 * Minimal shape the type/occurrence property merge needs. `properties` is
 * `readonly` so consumers whose own type declares it as a `ReadonlyArray`
 * (`@ifc-lite/lens`'s `PropertySetInfo`) still satisfy the constraint and
 * infer their own element type rather than falling back to this one.
 */
interface NamedPropertySet {
    name: string;
    properties: readonly { name: string }[];
}

/**
 * Compose an occurrence's own property sets with those it inherits from its
 * `IfcTypeProduct`, the way IFC defines the inheritance: **per property, not
 * per property set**.
 *
 * An occurrence and its type routinely both carry a set of the same name —
 * `Pset_CoveringCommon` holding `IsExternal`/`Reference` on the occurrence and
 * `SurfaceSpreadOfFlame`/`Combustible` on the type is a plain Revit export.
 * Dropping the whole inherited set on a name collision makes every type-only
 * property in it invisible, which is what made IDS report a present property as
 * missing (#1913). Where both define the same property name, the occurrence
 * wins — it is the more specific definition.
 *
 * An occurrence may carry **several** sets of one name (one per
 * `IfcRelDefinesByProperties`; nothing dedupes them, and merged/federated
 * exports produce them). Inherited properties are merged into *every* one of
 * them, not just the first: IDS requires every set matching the facet's
 * `propertySet` constraint to satisfy it, so augmenting one and leaving its
 * twin bare would reintroduce the same false "not found" this rule exists to
 * prevent.
 *
 * Neither input is mutated: a set that gains inherited properties is returned
 * as a new object, so cached extractor results stay intact.
 */
export function mergeInheritedPropertySets<T extends NamedPropertySet>(
    ownSets: readonly T[],
    inheritedSets: readonly T[],
): T[] {
    return mergeInheritedNamedSets(
        ownSets,
        inheritedSets,
        (set) => set.properties,
        // `as T`: the spread reproduces every field of `set` and replaces only
        // `properties` with a superset of the same element type, but
        // TypeScript cannot narrow a spread of an unresolved generic back to
        // that generic.
        (set, properties) => ({ ...set, properties }) as T,
    );
}

/**
 * Minimal shape the type/occurrence quantity merge needs — the quantity
 * counterpart of {@link NamedPropertySet}.
 */
interface NamedQuantitySet {
    name: string;
    quantities: readonly { name: string }[];
}

/**
 * Compose an occurrence's own quantity sets (`IfcElementQuantity`) with those
 * it inherits from its `IfcTypeProduct`, applying the same per-item rule
 * {@link mergeInheritedPropertySets} applies to property sets: a same-named
 * set does not replace or get replaced wholesale, it is topped up quantity by
 * quantity, and the occurrence wins a same-named-quantity collision.
 *
 * IFC does not distinguish properties from quantities for this purpose —
 * both live in the type's `HasPropertySets` list alongside each other — so a
 * consumer that resolves inherited properties this way but resolves
 * quantities by only ever looking at the occurrence's own sets silently
 * drops every quantity a type-level `Qto_*` set carries (e.g.
 * `Qto_WallBaseQuantities` attached to `IfcWallType` rather than each wall).
 */
export function mergeInheritedQuantitySets<T extends NamedQuantitySet>(
    ownSets: readonly T[],
    inheritedSets: readonly T[],
): T[] {
    return mergeInheritedNamedSets(
        ownSets,
        inheritedSets,
        (set) => set.quantities,
        (set, quantities) => ({ ...set, quantities }) as T,
    );
}

/**
 * Identity key for a property/quantity set: `(name, globalId)` joined with a
 * NUL separator, the same convention `groupPropertySetsByInstance`/
 * `groupQuantitySetsByInstance` (`@ifc-lite/data`) use for the occurrence-level
 * `PropertyTable`/`QuantityTable` (#3603, #3606). A name alone is only a proxy
 * for identity: two distinct `IfcPropertySet`/`IfcElementQuantity` instances
 * routinely share a literal name (a federated merge, or an exporter emitting
 * the same `Qto_` set twice), and a name-only key folds one into the other,
 * silently dropping whichever loses (#3722). Those helpers operate on
 * columnar `Uint32Array` string-table indices and this module on
 * already-extracted set objects, so the identity-key SHAPE is shared but not
 * the function itself.
 */
export function setIdentityKey(set: { name: string; globalId?: string }): string {
    return set.name + '\u0000' + (set.globalId ?? '');
}

/**
 * Append the sets a type carries via `IfcRelDefinesByProperties` to the ones
 * already collected from its `HasPropertySets` attribute, listing a set that is
 * reachable BOTH ways only once.
 *
 * The dedupe is by express id first. A name is only a proxy for identity, and
 * since #3530 it stopped being even that: every set the source left unnamed
 * now reports `''`, so a name-only check would fold every unnamed set from the
 * second source into the first unnamed one from the first and drop its
 * properties outright. The identity-key check ({@link setIdentityKey}) is still
 * applied on top for genuinely named sets, where an empty set from one source
 * must not shadow a populated same-named set from the other -- but it keys on
 * `(name, globalId)`, not name alone, so two distinct same-named instances
 * (different GlobalId) both survive (#3722); only a second row of the SAME
 * instance still collapses.
 *
 * `extract` is called at most once, with the ids the first source did not
 * already contribute.
 */
export function appendSetsFromSecondSource<T extends { name: string; globalId?: string }>(
    into: T[],
    firstSourceIds: ReadonlySet<number>,
    firstSourceKeys: ReadonlySet<string>,
    candidateIds: readonly number[],
    extract: (ids: number[]) => T[],
): void {
    const fresh = candidateIds.filter((id) => !firstSourceIds.has(id));
    if (fresh.length === 0) return;
    const acceptedKeys = new Set<string>();
    for (const set of extract(fresh)) {
        // A set with either a name or a globalId has an identity worth
        // deduplicating on; only a set with neither passes through unkeyed.
        if (set.name || set.globalId) {
            const key = setIdentityKey(set);
            if (firstSourceKeys.has(key) || acceptedKeys.has(key)) continue;
            acceptedKeys.add(key);
        }
        into.push(set);
    }
}
