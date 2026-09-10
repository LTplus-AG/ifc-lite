/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The IDS property overlay, split into a main-thread half and a
 * realm-neutral half (#3946).
 *
 * ## Why this file exists
 *
 * `MutablePropertyView` is a live main-thread object: it holds closures
 * (the on-demand property/attribute extractors), a base `PropertyTable`
 * and the whole mutation history, none of which survives structured
 * clone. That is the entire reason the IDS worker could not see pending
 * property edits, and the reason `useIDS` used to answer "there are
 * edits" by dropping the WHOLE validation run onto the main thread —
 * unbounded by model size, and identical in cost for one edit or a
 * thousand (#3946).
 *
 * What the bridge actually consumes is far smaller: a
 * `PropertyOverlayResolver`, i.e. `expressId -> PropertyOverride[]`, where
 * a `PropertyOverride` is plain scalar data. That IS clonable. So the
 * overlay crosses to the worker as a snapshot of that projection —
 * O(pending edits), not O(model size).
 *
 * ## The equivalence this file is shaped to guarantee
 *
 * Both realms must apply the SAME overrides, or the worker would answer a
 * different question from the main thread and the fallback would stop
 * being a fallback. Rather than assert that in a comment, there is
 * exactly ONE projection function here — {@link overridesForEntity} —
 * and both realms reach the bridge through it:
 *
 *   main thread:  overlayResolverFromSnapshot(snapshotPropertyOverlay(view))
 *   worker:       overlayResolverFromSnapshot(snapshot posted to it)
 *
 * `snapshotPropertyOverlay` is nothing but `overridesForEntity` evaluated
 * eagerly over every entity the overlay could possibly answer for, so the
 * snapshot resolver and a lazy resolver over the same view are equal on
 * every express id by construction, not by inspection.
 *
 * ## What the overlay does NOT carry, and why that is not a regression
 *
 * `MutablePropertyView.hasPendingChanges()` is true for eleven kinds of
 * overlay state (quantity edits, attribute edits, positional attribute
 * edits, retypes, pset/qset creates and deletes, overlay-created entities,
 * tombstones, as well as property edits). This snapshot carries only the
 * scalar property overrides.
 *
 * That matches what the accessor could ever have reflected. The bridge's
 * `createDataAccessor(store, overlay)` consults the overlay in exactly two
 * methods — `getPropertyValue` and `getPropertySets`; every other read
 * (attributes, classifications, materials, partOf, predefined types,
 * entity type) goes straight to the `IfcDataStore`, which the mutation
 * overlay never writes into. So the pre-#3946 main-thread path did not
 * reflect the other ten kinds either: routing a retype or a tombstone to
 * the main thread bought nothing it could show. Only property edits were
 * ever visible, and property edits are exactly what crosses here.
 */

import type {
  PropertyOverride,
  PropertyOverlayResolver,
} from '@ifc-lite/ids/bridge';
import type { Mutation, MutablePropertyView } from '@ifc-lite/mutations';

/**
 * The overlay reduced to structured-clone-safe plain data: one entry per
 * entity that currently carries at least one property override.
 *
 * An array of pairs rather than a `Map` so the payload is also plain JSON
 * — the worker request is posted with no transfer list, and a test can
 * compare two snapshots with a deep-equal.
 */
export type PropertyOverlaySnapshot = Array<[expressId: number, overrides: PropertyOverride[]]>;

/**
 * The pending property overrides for ONE entity, or `undefined` when it
 * has none. The single projection both realms use (see the module doc).
 *
 * `mutations` is this entity's slice of `mutationHistory`, and is used ONLY
 * to enumerate WHICH (psetName, propName) pairs it has ever touched — history is
 * append-only (undo re-applies the inverse mutation with `skipHistory=true`
 * "to avoid polluting mutation history", `mutationSlice.ts`, so it never
 * pops), but the identity of a touched key never becomes wrong, only stale.
 * The actual current state/value for each key comes from
 * `MutablePropertyView.getPropertyMutation()` — the live overlay map
 * (`propertyMutations`), same source `hasChanges()` / `getModifiedEntityCount()`
 * read instead of history, for the same reason. Reading `mutation.newValue`
 * straight from history here was the bug (#3929): after an undo, the live
 * overlay had reverted but this projection still reported the pre-undo
 * (corrected) value as an active override, so IDS re-validation kept
 * reporting PASS on data that had actually reverted to failing.
 *
 * Only property mutations with a scalar value are projected — list/array
 * property values aren't part of this overlay's contract and are skipped
 * rather than mis-rendered.
 */
function overridesForEntity(
  view: MutablePropertyView,
  expressId: number,
  mutations: readonly Mutation[]
): PropertyOverride[] | undefined {
  if (mutations.length === 0) return undefined;

  const seen = new Set<string>();
  const overrides: PropertyOverride[] = [];
  for (const mutation of mutations) {
    if (!mutation.psetName || !mutation.propName) continue;
    const dedupeKey = JSON.stringify([mutation.psetName, mutation.propName]);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    // The live, current state of this key — never the (possibly stale)
    // `mutation` object itself. `undefined` means an undo unwound this key
    // back to "no override at all" (see `deleteProperty`'s
    // `deletePropertyMutation` branch): skip it so the read falls through
    // to the base value, exactly as if it had never been touched.
    const live = view.getPropertyMutation(expressId, mutation.psetName, mutation.propName);
    if (!live) continue;

    if (live.operation === 'DELETE') {
      overrides.push({ psetName: mutation.psetName, propName: mutation.propName, value: null, deleted: true });
      continue;
    }

    const value = live.value ?? null;
    if (value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      // Array/list values aren't part of the overlay contract — skip
      // rather than write a shape the bridge doesn't expect.
      continue;
    }
    // `live.dataType` is set only when the writer knew one (currently
    // the IDS correction dialog, #3929/#3943) — it lets the bridge's
    // "no existing entry" branch (a PROPERTY_MISSING correction that
    // CREATES a property) scale through `toBaseSI` the same way the
    // "existing entry" branch already does. Absent for every other
    // writer, which keeps their overrides behaving exactly as before.
    overrides.push({
      psetName: mutation.psetName,
      propName: mutation.propName,
      value,
      dataType: live.dataType,
    });
  }
  return overrides.length > 0 ? overrides : undefined;
}

/**
 * Freeze the view's pending property overrides into plain, clonable data.
 * Main-thread only — it needs the live `MutablePropertyView`.
 *
 * The candidate express ids come from `getMutations()`, the SAME
 * append-only `mutationHistory` that `getMutationsForEntity()` filters, so
 * the id set enumerated here is exactly the id set for which
 * {@link overridesForEntity} can return anything but `undefined`. History
 * over-reports (an undone edit keeps its row), which only costs a
 * `getPropertyMutation` lookup that returns `undefined` and contributes no
 * entry — the same conservative direction `hasPendingChanges()` documents.
 * Under-reporting would be the dangerous direction and history cannot
 * under-report: it never shrinks.
 *
 * Cost is O(mutation history), i.e. O(edits the user actually made) — NOT
 * O(model size), which is the whole point of #3946.
 */
export function snapshotPropertyOverlay(view: MutablePropertyView): PropertyOverlaySnapshot {
  // Group in ONE pass. `getMutationsForEntity()` is a `filter` over the whole
  // history, so calling it per entity would make this O(edits^2): measured at
  // 174ms for 10k pending edits, which would put a main-thread stall straight
  // back — bounded by edit count rather than model size, but a stall. One pass
  // plus a per-entity projection is O(history).
  const byEntity = new Map<number, Mutation[]>();
  for (const mutation of view.getMutations()) {
    const bucket = byEntity.get(mutation.entityId);
    if (bucket) bucket.push(mutation);
    else byEntity.set(mutation.entityId, [mutation]);
  }

  const snapshot: PropertyOverlaySnapshot = [];
  for (const [expressId, mutations] of byEntity) {
    const overrides = overridesForEntity(view, expressId, mutations);
    if (overrides) snapshot.push([expressId, overrides]);
  }
  return snapshot;
}

/**
 * Rebuild the bridge's per-entity resolver from a snapshot. Realm-neutral:
 * plain data in, closure out, no `MutablePropertyView` at runtime (the
 * import above is type-only and erases), so the worker can call it.
 *
 * Returns `undefined` for an absent or empty snapshot so the caller hands
 * the bridge no overlay at all, which is the byte-identical no-overlay
 * path rather than an overlay that always answers `undefined`.
 */
export function overlayResolverFromSnapshot(
  snapshot: PropertyOverlaySnapshot | undefined
): PropertyOverlayResolver | undefined {
  if (!snapshot || snapshot.length === 0) return undefined;
  const byEntity = new Map<number, PropertyOverride[]>(snapshot);
  return (expressId: number) => byEntity.get(expressId);
}
