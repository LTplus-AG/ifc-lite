/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The property-set/quantity-set collection phase of `StepExporter.export()`
 * (#2475 step 2b's collection half): reads the overlay's pset/qset edits and
 * fills the `ExportPass` fields the generation phase
 * (`step-property-set-generators.ts`) and the type-owned rewrite
 * (`generatePropertyAndQuantitySetEntities` in `step-property-sets.ts`)
 * consume. Split out of `step-property-sets.ts` (#3184).
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import { extractQuantitiesOnDemand } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { PropertySet, QuantitySet } from '@ifc-lite/data';
import { isTypeClass } from './type-owned-psets.js';
import {
  type PropertySetContext,
  getPropertySetName,
  getPropertyIdsInSet,
  getTypeOwnedHasPropertySetIds,
  getElementQuantityName,
} from './step-property-set-readers.js';
import type { ExportPass, StepExportOptions } from './step-exporter.js';

/** The mutation groupings `export()` builds before the collection phase runs. */
export interface PropertyMutationGroups {
  readonly entityPropMutations: Map<number, Set<string>>;
  readonly entityQuantMutations: Map<number, Set<string>>;
  readonly relDefinesByEntity: Map<number, Array<{ relId: number; psetId: number }>>;
}

/**
 * The store the extractor THIS class installed on a view currently reads
 * (#2487). The extractor is installed once per view and closes over this box
 * rather than over a store directly, so a later export of the same view against
 * a different store re-points it instead of answering from the first file.
 *
 * A box, and not a `WeakSet` of views, because ownership has to reflect the
 * CURRENT state and not the historical fact that an export once installed
 * something. `setQuantityExtractor` is public: a caller may install its own
 * afterwards, and a marker saying "the exporter owns this view" would then keep
 * overwriting a caller-supplied base forever. With a box, the second export
 * writes to a box nothing reads any more and never calls the setter again, so
 * the caller's extractor stands. Weak, so it never keeps a session alive.
 */
const exporterQuantityBase = new WeakMap<MutablePropertyView, { store: IfcDataStore }>();

/**
 * Collect what the overlay's property-set and quantity-set edits mean for this
 * export: which sets to regenerate (`pass.newPropertySets` /
 * `pass.newQuantitySets`), which source records to withhold
 * (`pass.skipPropertySetIds` / `pass.skipRelationshipIds`), and which type
 * objects need their `HasPropertySets` resolved later
 * (`pass.typeOwnedPsetNamesByEntity`, `…IdsByEntity`, `pass.rewrittenEntityIds`).
 *
 * The caller owns the `mutationView && options.applyMutations !== false` gate;
 * reaching here means overlay edits were both present and enabled.
 */
export function collectPropertyAndQuantitySetMutations(
  pass: ExportPass,
  options: StepExportOptions,
  groups: PropertyMutationGroups,
  ctx: PropertySetContext,
): void {
  const { entityPropMutations, entityQuantMutations, relDefinesByEntity } = groups;
  // `export()` narrowed this through the enclosing `if`, and the caller still
  // owns that gate: reaching here means the view exists and mutations are
  // enabled. Named once here rather than asserted at each of the six reads.
  const mutationView = ctx.mutationView as MutablePropertyView;
  // Collect modified property sets and find original psets to skip
  for (const [entityId, psetNames] of entityPropMutations) {
    // A deleted entity must not cause the exporter to REMOVE anything.
    //
    // This is the other half of the dangling-reference class, and the half
    // `willBeEmitted` cannot reach: that predicate guards what gets ADDED,
    // and this loop's real work is deciding what gets SKIPPED. An edited
    // pset is replaced wholesale, so its original id goes into
    // `skipPropertySetIds` — but IFC exporters share one IfcPropertySet
    // between entities, and once the host is deleted there is no
    // replacement to take its place. The surviving entity's relation then
    // points at a container nobody wrote. Verified against main at
    // e6516991 (#2030's own merge): edit `Pset_WallCommon` on one of two
    // walls sharing it, delete that wall, and the export drops #11 while
    // #12 still names it. `retainSharedAtoms` rescues a shared ATOM one
    // level down; nothing rescues the shared container.
    //
    // Leaving the pset alone makes it an orphan when nothing else
    // references it, which is valid IFC. Its relation is dropped by the
    // sweep above, which handles a plain delete too — no pset edit needed.
    if (pass.effective.isDeleted(entityId)) continue;
    pass.modifiedEntities.add(entityId);
    // Same rule as the attribute loop below: an overlay-CREATED entity is
    // emitted once, by the new-entities pass, and already counted in
    // `newEntityCount` — as are the pset entities this loop goes on to
    // generate. Only the COUNT is guarded; the entity still records its
    // pset edits and still emits them.
    //
    // A NOMINATION, in both modes, never a count on its own: this site sees
    // a pset NAME the session touched, not whether that name resolves to
    // anything. `deletePropertySet(id, 'AName')` on a host that owns no such
    // set reaches here and changes nothing at all, and used to put "1
    // modification" in the header of a byte-identical file (#2474). What
    // settles it is the generator's `recordEmitted` and the skip branches'
    // `recordWithheld` below.
    if (!pass.isOverlayCreated(entityId) && pass.hasEmittableHostBytes(entityId)) {
      pass.modifications.nominate(entityId, 'property-set');
    }

    // Get the FULL mutated property sets for this entity (merged base + mutations)
    const allPsets = mutationView.getForEntity(entityId);
    const relevantPsets = allPsets.filter((pset: PropertySet) => psetNames.has(pset.name));
    const relDefinedPsetNames = new Set<string>();

    if (relevantPsets.length > 0) {
      pass.newPropertySets.push({ entityId, psets: relevantPsets });
    }

    // Find original property set IDs and relationship IDs to skip — look
    // up only the IfcRelDefinesByProperties rels that reference this entity.
    const rels = relDefinesByEntity.get(entityId);
    if (rels) {
      for (const { relId, psetId: relatedPsetId } of rels) {
        // Check if this pset is one we're modifying
        const psetName = getPropertySetName(ctx, relatedPsetId);
        if (psetName) {
          relDefinedPsetNames.add(psetName);
        }
        if (psetName && psetNames.has(psetName)) {
          pass.skipRelationshipIds.add(relId);
          pass.skipPropertySetIds.add(relatedPsetId);
          // Also skip the individual properties in this pset
          const propIds = getPropertyIdsInSet(ctx, relatedPsetId);
          for (const propId of propIds) {
            pass.skipPropertySetIds.add(propId);
          }
          // The other half of "did this edit change the file": a full export
          // applies a set DELETION by leaving these lines out, and produces
          // no replacement content to record an emission for. Without this
          // the count would settle from the generator alone and a real
          // deletion would stop counting along with the no-op one (#2474).
          pass.modifications.recordWithheld(entityId, 'property-set');
        }
      }
    }

    if (isTypeClass(pass.effective.typeOf(entityId))) {
      const typeOwnedPsetIds = getTypeOwnedHasPropertySetIds(ctx, entityId, pass.effective);
      const typeOwnedAffected = new Set<string>();

      for (const psetId of typeOwnedPsetIds) {
        const psetName = getPropertySetName(ctx, psetId);
        if (!psetName || !psetNames.has(psetName)) continue;
        typeOwnedAffected.add(psetName);
        pass.skipPropertySetIds.add(psetId);
        const propIds = getPropertyIdsInSet(ctx, psetId);
        for (const propId of propIds) {
          pass.skipPropertySetIds.add(propId);
        }
        // No `recordWithheld` twin of the rel-defined branch above, and
        // deliberately: a name that matches an OWNED pset is either dropped
        // from the resolved list or swapped for the replacement this export
        // generated, so slot 5 always comes back different and the repoint
        // below records the emission for it. A second record here would be
        // one no mutation can kill.
      }

      for (const psetName of psetNames) {
        if (!relDefinedPsetNames.has(psetName)) {
          typeOwnedAffected.add(psetName);
        }
      }

      if (typeOwnedAffected.size > 0) {
        pass.typeOwnedPsetNamesByEntity.set(entityId, typeOwnedAffected);
        pass.typeOwnedPsetIdsByEntity.set(entityId, typeOwnedPsetIds);
        pass.rewrittenEntityIds.add(entityId);
      }
    }
  }

  // Collect modified quantity sets (only if quantities are included)
  if (options.includeQuantities === false) entityQuantMutations.clear();
  // A quantity overlay with nothing under it regenerates a source quantity
  // set from the edited quantity ALONE, and the skip loop below then
  // withholds the source lines that held its siblings (#2487). Unlike
  // properties — whose base falls back to the `baseTable` the view was
  // constructed with — quantities have only the opt-in
  // `setQuantityExtractor`, so the default really is an empty base, and
  // four in-tree callers plus every external embedder never set it.
  //
  // The exporter is the one place that always holds the missing half: it
  // was handed the very store the view is an overlay ON. Supplying it here
  // makes the loss impossible for every caller rather than for the callers
  // we happened to find, and a view that resolves its own quantities (the
  // viewer, MCP, the CLI headless backend) is never overwritten.
  //
  // The extractor closes over ONE store, and the view outlives this export.
  // So it closes over a BOX this class owns instead: a second export of the
  // same view against a DIFFERENT store re-points that box rather than
  // reading the first store's quantities, which is the one way "install only
  // when absent" could have answered from the wrong file. The setter is
  // called at most once per view, so a caller that installs its own
  // extractor at any point — before the first export or after it — keeps it.
  //
  // `hasQuantityBase` and `setQuantityExtractor` are probed, like every other
  // optional view capability this class reaches for (`peekNextExpressId`,
  // `getNewEntities`, `getEntityTypeMutation`): `MutablePropertyView` is
  // published API arriving from a separately versioned package, and callers
  // pass partial and duck-typed views. `hasQuantityBase` is newer than
  // `setQuantityExtractor`, and without it there is no way to tell an empty
  // base from a caller-supplied one — so an older view falls back to the
  // pre-#2487 behaviour (no base supplied) rather than risk overwriting one.
  const quantityView = mutationView;
  if (
    entityQuantMutations.size > 0 &&
    typeof quantityView.setQuantityExtractor === 'function' &&
    typeof quantityView.hasQuantityBase === 'function'
  ) {
    const installed = exporterQuantityBase.get(quantityView);
    if (installed) {
      // Ours, or a caller's that replaced ours: re-pointing the box is a
      // no-op in the second case, and calling the setter again is what
      // would not be.
      installed.store = ctx.dataStore;
    } else if (!quantityView.hasQuantityBase()) {
      const box = { store: ctx.dataStore };
      exporterQuantityBase.set(quantityView, box);
      quantityView.setQuantityExtractor((id: number) => extractQuantitiesOnDemand(box.store, id));
    }
  }
  for (const [entityId, qsetNames] of entityQuantMutations) {
    // Same rule as the property loop above: a deleted entity removes nothing.
    if (pass.effective.isDeleted(entityId)) continue;
    pass.modifiedEntities.add(entityId);
    // See the property loop above — an overlay-created entity is counted as
    // new, not modified. The pset loop's own nomination no longer has to be
    // excluded to avoid a double count: the ledger settles per ENTITY, so a
    // host with both a pset and a qset edit counts once whatever is
    // nominated. Nominating both buys the opposite — an accurate warning
    // when the qset half is the half a delta cannot carry.
    //
    // Settled from effect like its property-set twin (#2474). The reachable
    // no-op here is an UNDONE quantity-set creation whose name matches NO
    // source set: `getMutations()` is append-only, so the `CREATE_QUANTITY`
    // record still names the qset after `removeQuantityMutation` has taken
    // it out of the overlay, and the generator below then finds nothing to
    // write. The same undo against a COLLIDING name is not a no-op — it
    // withholds the source set's lines — which is what the skip loop's
    // `recordWithheld` below settles.
    if (!pass.isOverlayCreated(entityId) && pass.hasEmittableHostBytes(entityId)) {
      pass.modifications.nominate(entityId, 'quantity-set');
    }

    const allQsets = mutationView.getQuantitiesForEntity(entityId);
    const relevantQsets = allQsets.filter((qset: QuantitySet) => qsetNames.has(qset.name));

    if (relevantQsets.length > 0) {
      pass.newQuantitySets.push({ entityId, qsets: relevantQsets });
    }

    // The names this export is actually WRITING a replacement for. The
    // affected-name set is not the same thing: it comes from the session's
    // append-only mutation history, which keeps naming a quantity set after
    // an undo has taken it back out of the overlay, so a Ctrl+Z used to
    // withhold a source `IfcElementQuantity` that nothing regenerated.
    //
    // A quantity-set REMOVAL is the one case where withholding WITHOUT a
    // replacement is the intent rather than the bug. It had no public
    // populator when #2487 wrote that rule, so the rule read "always the
    // bug"; `MutablePropertyView.deleteQuantitySet` (#2508) gives it one,
    // and the deleted set is now asked for by name below. Without that, the
    // panel hid a base quantity set the exported file still carried.
    const regeneratedQsetNames = new Set(relevantQsets.map((qset: QuantitySet) => qset.name));

    // Skip original quantity set entities (IfcElementQuantity).
    // Same per-entity index lookup as the property branch above.
    const rels = relDefinesByEntity.get(entityId);
    if (rels) {
      for (const { relId, psetId: relatedPsetId } of rels) {
        const qsetName = getElementQuantityName(ctx, relatedPsetId);
        const deleted = qsetName !== null
          && mutationView.isQuantitySetDeleted?.(entityId, qsetName) === true;
        if (qsetName && (regeneratedQsetNames.has(qsetName) || deleted)) {
          pass.skipRelationshipIds.add(relId);
          pass.skipPropertySetIds.add(relatedPsetId);
          const quantIds = getPropertyIdsInSet(ctx, relatedPsetId);
          for (const quantId of quantIds) {
            pass.skipPropertySetIds.add(quantId);
          }
          // The withheld half, exactly as the rel-defined property branch
          // above. This loop has just decided that #`relatedPsetId`, its
          // quantity atoms and the relationship that attached them do NOT
          // go into the file; whether anything is generated to take their
          // place is decided elsewhere, and is not this branch's to assume.
          //
          // It IS assumable for the pset side and not here, and the
          // difference is where the two read their base from.
          // `getForEntity` merges the overlay over the base pset walk, so a
          // name the session touched but did not change still resolves to
          // source content and is regenerated.
          // `getQuantitiesForEntity` merges the overlay over
          // `quantityExtractor`, which is OPT-IN: it defaults to null, and
          // several in-tree callers wire the property extractor beside it
          // and not it (`cli/commands/mutate.ts`, `gym.ts`,
          // `generate-spaces.ts`, `export/demesh-session.ts`), as does any
          // external embedder of these two published packages. With no
          // extractor the base is empty and the overlay is the only source,
          // so a qset the overlay no longer holds resolves to nothing.
          //
          // Which makes this reachable through an UNDONE quantity-set
          // creation whose name COLLIDES with a source set:
          // `setQuantity(id, 'Qto_WallBaseQuantities', ...)` followed by the
          // `removeQuantityMutation` that mutationSlice runs on Ctrl+Z. The
          // append-only history still names the qset, so this branch
          // withholds the source lines; the overlay is empty again, so
          // nothing is regenerated. The export drops the source quantity set
          // — a real change to the file, and a data-loss bug of its own
          // (#2487) — and this call is what stops the count from calling it
          // nothing.
          pass.modifications.recordWithheld(entityId, 'quantity-set');
        }
      }
    }
  }
}
