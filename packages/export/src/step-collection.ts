/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The collection phase of `StepExporter.export()` (#2475, the collection
 * block): builds the visible-only closure (`pass.allowedEntityIds` /
 * `hiddenProductIds`), groups the overlay's mutation history by entity and
 * kind, and applies the georeferencing edits. Nothing here WRITES a STEP
 * line — every write happens in a later phase (`step-source-iteration.ts`,
 * `step-property-sets.ts`, `step-georeferencing.ts`'s own new-entity lines,
 * `step-overlay-entities.ts`) that reads what this phase left on `pass`.
 *
 * `PropertyMutationGroups` (`step-property-sets.ts`) already names the
 * boundary this module sits behind: "the mutation groupings `export()`
 * builds before the collection phase runs." This is that builder, plus the
 * two collection calls (`buildRelDefinesByPropertiesIndex` /
 * `collectPropertyAndQuantitySetMutations`) it was already handing them to.
 *
 * `hasAnyUnreadableSourceRef` and the `mayNameOmittedRefs` /
 * `isOmittedFromOutput` predicates it feeds stay in `step-exporter.ts`:
 * they read `pass.effective` and this phase's OUTPUT (`allowedEntityIds`,
 * `overlayActive`), but nothing here reads them back, so moving them here
 * would not shrink a dependency, only relocate it.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { collectReferencedEntityIds, getVisibleEntityIds, collectStyleEntities } from './reference-collector.js';
import {
  buildRelDefinesByPropertiesIndex,
  collectPropertyAndQuantitySetMutations,
  type PropertySetContext,
} from './step-property-sets.js';
import { applyGeoreferencingMutations, type GeorefContext } from './step-georeferencing.js';
import type { ExportPass, StepExportOptions } from './step-exporter.js';

/**
 * The exporter state this phase cannot read off the pass.
 *
 * `propertySetContext` and `georefContext` are thunks, not values, matching
 * every other call site of theirs in `export()`: this phase calls
 * `propertySetContext()` twice (once for `buildRelDefinesByPropertiesIndex`,
 * once for `collectPropertyAndQuantitySetMutations`) and moving that call
 * out from under the two sites — deriving one value up front instead —
 * would be a behaviour change nothing here asked for.
 */
export interface CollectionContext {
  readonly dataStore: IfcDataStore;
  readonly mutationView: MutablePropertyView | null;
  readonly propertySetContext: () => PropertySetContext;
  readonly georefContext: (deltaOnly: boolean) => GeorefContext;
}

/**
 * Populate `pass` with everything the overlay's edits and `options` imply,
 * in place. The caller owns three gates and this phase does not re-derive
 * any of them: `applyMutations` (`options.applyMutations !== false`, read
 * once in `export()` — see the "read ONCE" comment there for why a second
 * read would be a bug, not a style choice), `options.visibleOnly`, and
 * `options.georefMutations`.
 */
export function collectModifications(
  pass: ExportPass,
  options: StepExportOptions,
  applyMutations: boolean,
  ctx: CollectionContext,
): void {
  if (options.visibleOnly && ctx.dataStore.source) {
    const visible = getVisibleEntityIds(
      ctx.dataStore,
      options.hiddenEntityIds ?? new Set(),
      options.isolatedEntityIds ?? null,
      pass.effective,
    );
    pass.hiddenProductIds = visible.hiddenProductIds;
    pass.allowedEntityIds = collectReferencedEntityIds(
      visible.roots,
      ctx.dataStore.source,
      pass.effective,
      visible.hiddenProductIds,
      pass.isRefExcludedDuringClosureWalk,
    );
    // Second pass: collect IFCSTYLEDITEM entities that reference included
    // geometry. Styled items reference geometry items but nothing references
    // them back, so the forward closure misses them.
    collectStyleEntities(
      pass.allowedEntityIds,
      ctx.dataStore.source,
      { byId: pass.effective, byType: pass.effective.byType },
    );
  }

  // Process mutations if we have a mutation view
  if (ctx.mutationView && applyMutations) {
    const mutationView = ctx.mutationView;
    const mutations = mutationView.getMutations();

    // Attribute values come from the *overlay*, never from the mutation
    // history. The history is append-only and undo writes its reverse edit
    // with `skipHistory: true`, so a superseded UPDATE_ATTRIBUTE record keeps
    // its stale `newValue` forever — replaying it resurrects edits the user
    // undid (#1957). The overlay is what the editor shows, and it is already
    // the source for psets, quantities, positional attributes and retypes
    // below, so attributes were the sole outlier.
    for (const [entityId, attrs] of mutationView.getAttributeMutationsByEntity()) {
      pass.modifiedEntities.add(entityId);
      let target = pass.modifiedAttributes.get(entityId);
      if (!target) {
        target = new Map();
        pass.modifiedAttributes.set(entityId, target);
      }
      for (const [name, value] of attrs) target.set(name, value);
    }

    // Group mutations by entity, separating property vs quantity mutations
    const entityPropMutations = new Map<number, Set<string>>();
    const entityQuantMutations = new Map<number, Set<string>>();
    for (const mutation of mutations) {
      // Handled above, off the overlay. Skipped explicitly because an
      // UPDATE_ATTRIBUTE record can also carry a `psetName` (georef fields
      // encode their target entity there) and must not be mistaken for a
      // property-set edit.
      if (mutation.type === 'UPDATE_ATTRIBUTE') continue;

      if (!mutation.psetName) continue;

      const isQuantity = mutation.type === 'CREATE_QUANTITY' || mutation.type === 'UPDATE_QUANTITY'
        || mutation.type === 'DELETE_QUANTITY' || mutation.type === 'DELETE_QUANTITY_SET';
      const targetMap = isQuantity ? entityQuantMutations : entityPropMutations;

      if (!targetMap.has(mutation.entityId)) {
        targetMap.set(mutation.entityId, new Set());
      }
      targetMap.get(mutation.entityId)!.add(mutation.psetName);
    }

    // Build a reverse index of IfcRelDefinesByProperties → (relId, psetId)
    // pairs keyed on each related entity. The two property/quantity loops
    // below previously walked every entity in `entityIndex.byId` per
    // modified entity (O(E·N)); the index keeps the per-entity step
    // O(K) where K is the number of rels referencing that entity.
    const { byEntity: relDefinesByEntity, relatedByRel } = buildRelDefinesByPropertiesIndex(ctx.propertySetContext());

    // A source IfcRelDefinesByProperties whose EVERY related object the
    // session deleted has nothing left to relate, and emitting it leaves a
    // `#id` pointing at a record the export skipped. Dropped only when all of
    // them are gone: a rel that still names a live entity is that entity's
    // only link to its psets, and nothing here rewrites a RelatedObjects list.
    for (const [relId, related] of relatedByRel) {
      if (related.length > 0 && related.every((id) => pass.effective.isDeleted(id))) {
        pass.skipRelationshipIds.add(relId);
      }
    }

    collectPropertyAndQuantitySetMutations(
      pass,
      options,
      { entityPropMutations, entityQuantMutations, relDefinesByEntity },
      ctx.propertySetContext(),
    );

    for (const [entityId] of pass.modifiedAttributes) {
      // An overlay-CREATED entity carrying attribute edits is emitted once,
      // by the new-entities pass, and already counted in `newEntityCount`.
      // Counting it here too made the header claim two affected entities for
      // one created-then-renamed wall.
      if (pass.isOverlayCreated(entityId)) continue;
      // A source entity with no bytes never gets its line rewritten (the
      // source-iteration pass skips it), so an attribute edit against it
      // must not inflate the count either.
      if (!pass.hasEmittableHostBytes(entityId)) continue;
      // Under `deltaOnly` this only NOMINATES the host's ATTRIBUTE edits:
      // nothing writes an in-place attribute edit into a delta except the
      // type-object line rewrite, so the ledger drops it at settle time
      // unless that pass reports having carried it (#2462). That nomination
      // is deliberately made at INTENT: the per-kind warning exists to NAME
      // an edit the delta could not carry, and an undeliverable edit is
      // exactly the one that must still be named.
      //
      // A FULL export has no such warning, so an edit that resolved to
      // nothing has nothing to say and nothing to claim — it waits for the
      // rewrite instead. `setAttribute` to the value already in the slot, and
      // `setAttribute` naming a slot the class does not declare, both leave
      // the line byte-identical and used to count anyway (#2483).
      //
      // Recorded unconditionally. It used to be skipped for a host that also
      // had a pset or qset edit, because the count was per entity and the
      // other loop had already nominated it — which is exactly what let a
      // pset emission mark the rename delivered and suppress its warning. The
      // ledger de-duplicates the COUNT per entity now, so the two edits can
      // and must be nominated separately.
      pass.inPlaceNominees.attribute.add(entityId);
      if (options.deltaOnly === true) pass.modifications.nominate(entityId, 'attribute');
    }
  }

  // Process georeferencing mutations (only when applyMutations is enabled)
  if (applyMutations && options.georefMutations) {
    applyGeoreferencingMutations(pass, options.georefMutations, ctx.georefContext(options.deltaOnly === true));
  }
}
