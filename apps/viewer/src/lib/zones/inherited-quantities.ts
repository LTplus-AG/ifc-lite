/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The quantity sets a volume basis may be read from: an element's own, plus
 * those it INHERITS from its `IfcTypeObject` (#1745/#1755), for the zone volume
 * breakdown (#2508).
 *
 * A pure function over a store-shaped argument rather than a few lines inside
 * `PropertiesPanel`'s memo, because the thing worth pinning is the ORDER and
 * the two parse paths, and neither is observable from a rendered panel without
 * a whole model behind it.
 *
 * **Order is the merge rule.** `declaredVolumeBases` keeps the FIRST value it
 * sees per basis, so appending the type's sets means the occurrence still wins
 * for any basis it declares and the type only fills a basis the occurrence is
 * silent on. Prepending would let a catalogue's type-level `NetVolume` shadow
 * the occurrence's own.
 *
 * **Both parse paths.** `extractTypeQuantitiesOnDemand` walks STEP source and
 * returns `null` outright when there is none — which is every server-parsed
 * store — so that path reads the prebuilt table keyed by the TYPE's express id
 * instead. Same split `lib/lists/adapter.ts` makes for the same reason.
 */

/** The minimal quantity-set shape this module moves around. */
export interface InheritableQuantitySet {
  name: string;
  quantities: ReadonlyArray<{ name: string; type: number; value: number }>;
}

/** Just enough of `IfcDataStore` to resolve a type and its quantity sets. */
export interface TypeQuantityStoreLike {
  source?: { length: number } | null;
  relationships?: { getRelated(id: number, rel: number, direction: 'inverse'): number[] } | null;
  quantities?: { getForEntity(id: number): InheritableQuantitySet[] } | null;
}

/**
 * `own` followed by the element's inherited type quantity sets. Returns `own`
 * unchanged — the same array reference, so a `useMemo` downstream does not
 * re-run — when there is no type, no store, or the type declares nothing.
 *
 * `definesByType` is the caller's `RelationshipType.DefinesByType`; passed in
 * so this module does not pull `@ifc-lite/data` in for one enum member.
 */
export function withInheritedTypeQuantities<T extends InheritableQuantitySet>(
  own: readonly T[],
  store: TypeQuantityStoreLike | null | undefined,
  expressId: number | undefined,
  definesByType: number,
  extractFromSource: (store: TypeQuantityStoreLike, expressId: number) => readonly T[] | null | undefined,
): readonly T[] {
  if (!store || expressId === undefined) return own;
  const typeIds = store.relationships?.getRelated(expressId, definesByType, 'inverse') ?? [];
  if (typeIds.length === 0) return own;

  const inherited = (store.source?.length
    ? extractFromSource(store, expressId)
    : (store.quantities?.getForEntity(typeIds[0]) as readonly T[] | undefined)) ?? [];
  return inherited.length > 0 ? [...own, ...inherited] : own;
}
