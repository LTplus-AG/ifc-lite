/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * How property/quantity sets coming from two different sources compose: an
 * occurrence's own sets with the ones it inherits from its `IfcTypeProduct`
 * ({@link mergeInheritedPropertySets}), and a type's `HasPropertySets` list with
 * the sets attached to it by `IfcRelDefinesByProperties`
 * ({@link appendSetsFromSecondSource}).
 *
 * Their own module rather than a corner of `on-demand-extractors.ts`: the rules
 * are independent of how either side was extracted, and every consumer that
 * resolves sets from more than one source needs the same answer.
 */

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
        // property the two happen to share. Before #3530 the two carried
        // distinct `PropertySet #<id>` placeholders and were kept apart here;
        // an absent name is evidence of nothing, least of all of sameness.
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
            const ownPropNames = new Set(own.properties.map((p) => p.name));
            const additions = inherited.properties.filter((p) => !ownPropNames.has(p.name));
            if (additions.length === 0) continue;
            // `as T`: the spread reproduces every field of `own` and replaces
            // only `properties` with a superset of the same element type, but
            // TypeScript cannot narrow a spread of an unresolved generic back
            // to that generic.
            merged[index] = { ...own, properties: [...own.properties, ...additions] } as T;
        }
    }

    return merged;
}

/**
 * Append the sets a type carries via `IfcRelDefinesByProperties` to the ones
 * already collected from its `HasPropertySets` attribute, listing a set that is
 * reachable BOTH ways only once.
 *
 * The dedupe is by express id, not by name. A name is only a proxy for identity,
 * and since #3530 it stopped being even that: every set the source left unnamed
 * now reports `''`, so a name-keyed check folds every unnamed set from the
 * second source into the first unnamed one from the first and drops its
 * properties outright. The name check is still applied on top for genuinely
 * named sets, where an empty set from one source must not shadow a populated
 * same-named set from the other.
 *
 * `extract` is called at most once, with the ids the first source did not
 * already contribute.
 */
export function appendSetsFromSecondSource<T extends { name: string }>(
    into: T[],
    firstSourceIds: ReadonlySet<number>,
    firstSourceNames: ReadonlySet<string>,
    candidateIds: readonly number[],
    extract: (ids: number[]) => T[],
): void {
    const fresh = candidateIds.filter((id) => !firstSourceIds.has(id));
    if (fresh.length === 0) return;
    for (const set of extract(fresh)) {
        if (set.name && firstSourceNames.has(set.name)) continue;
        into.push(set);
    }
}
