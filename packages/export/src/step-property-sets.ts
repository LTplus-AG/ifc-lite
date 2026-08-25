/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The write phase of the property-set and quantity-set generation
 * (#2475 steps 2b/2c): writes the records the generation phase
 * (`step-property-set-generators.ts`) produces into `pass.entities`, then
 * points every affected type object's `HasPropertySets` at them.
 *
 * `step-property-sets.ts` was split into this file plus
 * `step-property-set-readers.ts` (the shared {@link PropertySetContext} and
 * per-entity STEP-text readers), `step-property-set-index.ts` (the
 * IfcRelDefinesByProperties reverse index), `step-property-set-generators.ts`
 * (the two record generators) and `step-property-set-collection.ts` (the
 * overlay-edit collection phase) — #3184. This file kept the original name
 * because it is the phase `export()` calls last and the one every doc
 * comment elsewhere in the package already cites as `step-property-sets.ts`.
 *
 * ## The state this function cannot read off the pass
 *
 * `allocateExpressId` is the exporter's own `nextExpressId++`, shared with
 * the georeferencing phase, so it is injected as a callback on
 * {@link PropertySetContext} rather than hoisted onto the pass.
 */

import { decodeRange } from './source-ref-bounds.js';
import {
  resolveTypeOwnedPsetIds,
  rewriteTypeOwnedPsetLine,
  typeOwnedPsetRewriteWarning,
} from './type-owned-psets.js';
import { recordSourceLineDelivery } from './delta-modification-ledger.js';
import { nominateDeliveredInPlaceEdits } from './in-place-nomination.js';
import { type PropertySetContext, getPropertySetName } from './step-property-set-readers.js';
import { generatePropertySetEntities, generateQuantitySetEntities } from './step-property-set-generators.js';
import type { ExportPass, SourceLineMutations, StepExportOptions } from './step-exporter.js';


/**
 * Write the generated property-set and quantity-set records into
 * `pass.entities`, and point every affected type object's `HasPropertySets` at
 * the property sets this export just generated.
 *
 * Three loops, in the order `export()` ran them, and the order is load-bearing:
 * the rewrite reads `generatedTypeOwnedPsetIds` from the property-set loop, and
 * the caller flushes `pass.rewrittenEntityLines` — this function's output —
 * only after the quantity-set loop has run.
 */
export function generatePropertyAndQuantitySetEntities(
  pass: ExportPass,
  options: StepExportOptions,
  ctx: PropertySetContext,
): void {
  // Generate new property entities for mutations (these REPLACE the skipped ones)
  const generatedTypeOwnedPsetIds = new Map<number, Map<string, number>>();
  for (const { entityId, psets } of pass.newPropertySets) {
    // Nothing may be emitted FOR an entity that gets no defining line —
    // see `willBeEmitted` (#1978, #2030, #2012).
    if (!pass.willBeEmitted(entityId)) continue;
    const newEntities = generatePropertySetEntities(
      ctx,
      entityId,
      psets,
      pass.willBeEmitted,
      pass.effective,
      pass.typeOwnedPsetNamesByEntity.get(entityId),
      options.guidRandom
    );
    pass.entities.push(...newEntities.lines);
    pass.newEntityCount += newEntities.count;
    // Replacement content for this host actually landed, so a delta really
    // does carry its PROPERTY-SET modification — and only that one (#2462).
    if (newEntities.lines.length > 0) pass.modifications.recordEmitted(entityId, 'property-set');
    generatedTypeOwnedPsetIds.set(entityId, newEntities.generatedTypeOwnedPsetIds);
  }

  // Point every affected type object's HasPropertySets at the psets this
  // export generated. One loop, because a type whose affected psets produced
  // no replacement content (a deletion) needs exactly the same resolution
  // with an empty replacement map.
  for (const [entityId, typeOwnedPsetNames] of pass.typeOwnedPsetNamesByEntity) {
    // `entityId` here is a TYPE object rather than an element; `willBeEmitted`
    // resolves either the same way (#2030).
    if (!pass.willBeEmitted(entityId)) continue;
    const resolved = resolveTypeOwnedPsetIds(
      pass.typeOwnedPsetIdsByEntity.get(entityId) ?? [],
      typeOwnedPsetNames,
      generatedTypeOwnedPsetIds.get(entityId) ?? new Map(),
      (psetId) => getPropertySetName(ctx, psetId),
    );
    if (pass.effective.isOverlayCreated(entityId)) {
      // No source line to rewrite: the new-entities pass writes this record
      // from its authored payload, so the list rides in as a slot override.
      pass.overlayTypeOwnedPsets.set(
        entityId,
        resolved.length > 0 ? resolved.map((id) => `#${id}`) : null,
      );
      continue;
    }
    // This line REPLACES the one the source-iteration pass would have
    // written — `rewrittenEntityIds` makes that pass skip the entity — so it
    // has to carry the entity's other edits too, and it has to apply them
    // the way that pass does. It used to replace slot 5 and nothing else,
    // which dropped the rename in `setAttribute(id,'Name',…)` +
    // `addPropertySet(id,…)`, and then, once renames were special-cased
    // here, still dropped retypes and positional edits — same line, same
    // silence. So run the ONE pipeline both passes share and replace
    // `HasPropertySets` on its output. Order matters: see
    // {@link applySourceLineMutations}.
    const record = pass.effective.get(entityId);
    let sourceLine: string | null = null;
    let mutated: SourceLineMutations | null = null;
    // One narrowed block for both calls: `record` is in scope for the decode
    // AND for the record type below, with no non-null assertion to keep true
    // by hand. `byteOffset >= 0` is the same "are there real source bytes"
    // test the source-iteration pass makes — an overlay-authored record
    // carries `-1` there, and decoding from it would read another entity's
    // bytes rather than fall through to the no-source-bytes branch.
    // `isReadableSourceRef` folds in the `byteOffset >= 0 && byteLength > 0`
    // test this used to make by hand, and adds the bound the invariant used
    // to supply (#2491).
    if (record && pass.isReadableSourceRef(record)) {
      sourceLine = decodeRange(
        ctx.dataStore.source,
        record.byteOffset,
        record.byteOffset + record.byteLength,
      );
      // The RECORD's class is the from-type: the bytes are still the source
      // class, whatever `typeOf` now says the entity effectively is.
      mutated = ctx.applySourceLineMutations(
        entityId,
        sourceLine,
        record.type,
        pass.modifiedAttributes.get(entityId),
        pass.sourceSchema,
        pass.overlayActive,
        (attr, value) =>
          pass.warnings.push(
            `entity #${entityId}: attribute ${attr} not written - ` +
              `${JSON.stringify(value)} is not a number and the slot is REAL-typed`,
          ),
      );
    }
    if (mutated === null) {
      // `willBeEmitted` already required real source bytes for a non-overlay
      // record, so this is only reachable with no source buffer at all —
      // in which case the source-iteration pass never ran either and there is
      // nothing to lose. Say it anyway; the pset edit is still going nowhere.
      pass.warnings.push(typeOwnedPsetRewriteWarning(entityId, 'no-source-bytes'));
      // The line above IS the report, so the ledger must not add a second,
      // vaguer one blaming the delta format for a drop the format did not
      // cause.
      pass.modifications.acknowledgeUndelivered(entityId, 'property-set');
      continue;
    }
    const { line, repointed } = rewriteTypeOwnedPsetLine(mutated.text, resolved);
    if (repointed) {
      // A repoint that resolves to the list the line ALREADY names changes
      // nothing, and it is reachable: deleting a pset name the type object
      // does not own leaves every original id in place (it is "affected" but
      // matches none of them) and generates no replacement, so slot 5 comes
      // back byte-identical. Same rule as the fallback branch below — an
      // unchanged line has no place in a delta, and claiming it delivered the
      // edit would put a modification in the header over a line that carries
      // none. A FULL export still emits it: `rewrittenEntityIds` made the
      // source-iteration pass skip this entity, so withholding the line there
      // would delete the record from the file (#2469).
      const changed = line !== sourceLine;
      if (options.deltaOnly !== true || changed) {
        pass.rewrittenEntityLines.set(entityId, line);
      }
      // A rewritten source line IS in the delta — the one in-place change a
      // delta does carry today (#2462). The repoint itself delivers the
      // property-set edit that put this host in the loop; the rest of the
      // line delivers whichever in-place edits the pipeline applied to it.
      if (changed) {
        pass.modifications.recordEmitted(entityId, 'property-set');
        recordSourceLineDelivery(pass.modifications, entityId, mutated);
        // `rewrittenEntityIds` made the source-iteration pass skip this
        // host, so this line is the ONLY place a full export can see its
        // named-attribute edits land — per site, not per feature (#2483).
        nominateDeliveredInPlaceEdits(pass.modifications, entityId, mutated, pass.inPlaceNominees);
      }
      continue;
    }
    // A malformed source line — too few arguments to have a slot 5, or not
    // parseable as a STEP record at all. The entity must still come out:
    // `rewrittenEntityIds` made the source-iteration pass skip it, so
    // dropping the line here deletes the whole record from the file (#2469).
    pass.warnings.push(typeOwnedPsetRewriteWarning(entityId, 'unparseable-line'));
    // Same as the `no-source-bytes` branch: the property-set edit is
    // genuinely undelivered — the repoint is what would have delivered it and
    // it did not happen — but this warning already says so, precisely, so the
    // ledger stays quiet about that pair rather than duplicating it. (When
    // the affected psets produced replacement content, the property-set pass
    // above has already recorded the emission, and an emission outranks an
    // acknowledgement.)
    pass.modifications.acknowledgeUndelivered(entityId, 'property-set');
    // `line` is byte-for-byte what the source-iteration pass would have
    // written, so emit it wherever that pass would have run. Under
    // `deltaOnly` it does not run, and a line the mutation pipeline left
    // identical to its source is not a change — it has no place in a delta.
    const changed = line !== sourceLine;
    if (options.deltaOnly !== true || changed) {
      pass.rewrittenEntityLines.set(entityId, line);
    }
    // The ledger stays honest about WHICH modification landed: the
    // property-set edit that nominated this host is the thing that just
    // failed, so only the entity's OTHER edits are in this line. Under the
    // per-kind keying that comes out as `attribute/retype/positional:
    // delivered, property-set: undelivered` — the host still counts once,
    // because a real change of its did land.
    if (changed) {
      recordSourceLineDelivery(pass.modifications, entityId, mutated);
      // Same site rule as the repoint branch above: the failed repoint is
      // what did not land, and the line still carries the host's OTHER edits.
      nominateDeliveredInPlaceEdits(pass.modifications, entityId, mutated, pass.inPlaceNominees);
    }
  }

  // Generate new quantity entities for mutations
  for (const { entityId, qsets } of pass.newQuantitySets) {
    if (!pass.willBeEmitted(entityId)) continue;
    const newEntities = generateQuantitySetEntities(ctx, entityId, qsets, pass.willBeEmitted, options.guidRandom);
    pass.entities.push(...newEntities.lines);
    pass.newEntityCount += newEntities.count;
    if (newEntities.lines.length > 0) pass.modifications.recordEmitted(entityId, 'quantity-set');
  }
}
