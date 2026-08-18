/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The source-iteration phase of `StepExporter.export()` (#2475 step 2d): the
 * pass that writes one line per record the SOURCE file already holds, plus the
 * shared-atom retention that has to run before it decides what to skip.
 *
 * This phase reads more of the export's shared state than any other — 16 of
 * {@link ExportPass}'s members — and it consumes what three earlier phases
 * wrote: `modifiedAttributes` and `inPlaceNominees.georeferencing` from the
 * georeferencing phase (`step-georeferencing.ts`), and `rewrittenEntityIds` /
 * `skipPropertySetIds` / `allowedEntityIds` from the collection and setup
 * phases. It writes `pass.entities`, which `assembleStepBytes` turns into
 * bytes at the end of `export()`, and `pass.modifications`, which `settle()`
 * reads. Nothing pulls the other way, which is why it moves last.
 *
 * What is injected rather than moved, and why: the
 * `applySourceLineMutations` pipeline (and its `applyAttributeMutations` /
 * `applyPositionalMutations` / serialize helpers) is shared verbatim with the
 * type-object `HasPropertySets` rewrite in `step-property-sets.ts` and with
 * the overlay-created-entities block still in the exporter, so it belongs to
 * no single phase; `isGeometryEntity` is likewise read by the setup closure
 * and by the overlay block. `applyOverlayEntityOverrides` is NOT a dependency
 * of this phase at all — it is reached only from the overlay-created-entities
 * block — and stays where it is.
 *
 * Unlike `step-georeferencing.ts` this phase needs no `allocateExpressId`
 * callback: it never allocates an id, it only rewrites lines that already have
 * one.
 *
 * No test file travelled with this module, and that is a measured result, not
 * an omission. Disabling the loop at its call site kills 106 tests across 22
 * files — but that is the count of tests that need SOME source-backed line to
 * exist for their assertion to mean anything, not the count of tests of this
 * phase's logic (8 of them are in `step-georeferencing.test.ts`, a phase
 * already extracted). Mutating each of the phase's 27 individual sites instead
 * puts every narrow kill set in a file whose name already points at the code:
 * `shared-atom` for the retention pass, `source-ref-bounds` for the unreadable
 * ref guard, `includegeometry-header-count` for the geometry skip,
 * `visible-only-dangling-refs` for the relationship-ref filter,
 * `rewritten-type-line-attributes` for the rewritten-entity skip,
 * `overlay-effective-model` for the effective-type classification and
 * `delta-modification-count` for the two ledger writes. Every test file in this
 * package lives in one flat directory, so those names need no move — and unlike
 * step 2b/2c, `step-exporter.test.ts` holds no test that dies to a NARROW site
 * here, only ones that die because the file would otherwise be empty.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import { filterHiddenRefsFromRelationshipLine } from './reference-collector.js';
import { convertStepLine, type IfcSchemaVersion } from './schema-converter.js';
import { nominateDeliveredInPlaceEdits } from './in-place-nomination.js';
import { decodeRange } from './source-ref-bounds.js';
import { getPropertyIdsInSet, type PropertySetContext } from './step-property-sets.js';
import type { ExportPass, SourceLineMutations, StepExportOptions } from './step-exporter.js';

/**
 * The exporter state this phase cannot read off the {@link ExportPass}.
 *
 * `propertySetContext` is a thunk rather than a value because
 * {@link retainSharedAtoms} returns before it needs one when nothing is being
 * skipped, and because the exporter rebuilds that context per call — hoisting
 * a built one here would change when it is constructed, not merely where it is
 * named.
 */
export interface SourceIterationContext {
  readonly dataStore: IfcDataStore;
  /** `StepExporter.applySourceLineMutations`: the ONE pipeline this pass and
   *  the type-object rewrite share, so it belongs to neither and is injected. */
  readonly applySourceLineMutations: (
    expressId: number,
    entityText: string,
    recordType: string,
    attributeMutations: Map<string, string> | undefined,
    sourceSchema: IfcSchemaVersion,
    overlayActive: boolean,
  ) => SourceLineMutations;
  /** `StepExporter.isGeometryEntity`, also read by the setup closure and by
   *  the overlay-created-entities block. */
  readonly isGeometryEntity: (type: string) => boolean;
  /** `StepExporter.propertySetContext`, for the byte readers
   *  {@link retainSharedAtoms} reaches through `getPropertyIdsInSet`. */
  readonly propertySetContext: () => PropertySetContext;
}

/**
 * Un-skip property/quantity atoms that a surviving (non-skipped, and — under
 * visible-only export — still-included) IfcPropertySet / IfcElementQuantity
 * still references.
 *
 * When a property is edited, the modified pset is replaced and its member atoms
 * are added to `skipIds` wholesale. Because exporters deduplicate shared
 * Pset_*Common atoms (e.g. a single IsExternal / IsLoadBearing value referenced
 * by many psets), that wholesale skip can drop an atom another pset still needs.
 * This pass restores any such atom: the edited pset still emits its replacement
 * with the new value, while the shared atom stays for the psets that keep their
 * original value.
 */
function retainSharedAtoms(
  skipIds: Set<number>,
  allowedEntityIds: Set<number> | null,
  ctxOf: SourceIterationContext,
): void {
  if (skipIds.size === 0) return;
  // Built once for the whole sweep rather than per container: the readers in
  // `step-property-sets.ts` take the context, and this loop calls one of them
  // once per IfcPropertySet / IfcElementQuantity in the file.
  const ctx = ctxOf.propertySetContext();
  const byType = ctxOf.dataStore.entityIndex.byType;
  const containerIds = [
    ...(byType.get('IFCPROPERTYSET') ?? []),
    ...(byType.get('IFCELEMENTQUANTITY') ?? []),
  ];
  for (const containerId of containerIds) {
    // Skipped containers are being dropped/replaced — their atoms may go.
    if (skipIds.has(containerId)) continue;
    // Under visible-only export a container outside the closure is not emitted,
    // so it cannot keep an atom alive.
    if (allowedEntityIds !== null && !allowedEntityIds.has(containerId)) continue;
    for (const atomId of getPropertyIdsInSet(ctx, containerId)) {
      skipIds.delete(atomId);
    }
  }
}

/**
 * Write every source-backed record this export keeps, into `pass.entities`.
 *
 * Mutates the pass in place and returns nothing: three later readers take its
 * output at a distance — the assembly step reads `pass.entities`, `settle()`
 * reads `pass.modifications`, and the header count reads both.
 *
 * `mayNameExcludedRefs` is passed rather than read off the pass because it is
 * deliberately not a pass member: it folds in `hiddenProductIds`, which the
 * visible-only closure walk only assigns after the pass is constructed, so
 * hoisting it would change what it computes rather than where it is named. The
 * overlay-created-entities block reads the same local.
 */
export function writeSourceEntityLines(
  pass: ExportPass,
  options: StepExportOptions,
  mayNameExcludedRefs: boolean,
  ctx: SourceIterationContext,
): void {
  // A modified pset is replaced wholesale, which skips ALL of its member atoms.
  // But IFC exporters deduplicate identical Pset_*Common atoms (e.g. one
  // IsExternal IfcPropertySingleValue shared by dozens of psets), so skipping a
  // shared atom would orphan every OTHER pset that still references it, leaving
  // dangling refs and an invalid file. Keep any atom a surviving container needs.
  retainSharedAtoms(pass.skipPropertySetIds, pass.allowedEntityIds, ctx);

  // Export original entities from source buffer, SKIPPING modified property sets
  if (!options.deltaOnly && ctx.dataStore.source) {
    const source = ctx.dataStore.source;

    // Extract existing entities from source. The effective index has already
    // dropped everything the overlay tombstoned, so there is no separate
    // deleted check to forget here.
    for (const [expressId, entityRef] of pass.effective) {
      // Skip overlay-only entities — emitted by the overlay-created-entities
      // block back in `export()`.
      // A ref this source cannot address is skipped by the same test rather
      // than decoded: `decodeUtf8` clamps such a range and the empty string
      // it returns used to be pushed into the file as a blank line, leaving
      // every generated record that names the host dangling (#2491).
      if (!pass.isReadableSourceRef(entityRef)) {
        continue;
      }

      // Skip entities outside the visible closure
      if (pass.allowedEntityIds !== null && !pass.allowedEntityIds.has(expressId)) {
        continue;
      }

      // Skip property sets/relationships that are being replaced
      if (pass.skipPropertySetIds.has(expressId) || pass.skipRelationshipIds.has(expressId)) {
        continue;
      }

      // Skip type entities whose HasPropertySets attribute will be rewritten
      if (pass.rewrittenEntityIds.has(expressId)) {
        continue;
      }

      // Skip if we're only doing geometry or specific types
      const entityType = entityRef.type.toUpperCase();

      // Skip geometry if not included
      if (options.includeGeometry === false && ctx.isGeometryEntity(entityType)) {
        continue;
      }

      // Get original entity text — decodeRange handles SAB-backed
      // sources (Firefox/Chrome reject `TextDecoder.decode()` on a
      // SharedArrayBuffer-backed view; the parser deliberately keeps
      // `source` zero-copy SAB-backed for worker sharing).
      const entityText = decodeRange(
        source,
        entityRef.byteOffset,
        entityRef.byteOffset + entityRef.byteLength
      );
      // Retype, named attribute edits and positional edits, in that order.
      // Shared verbatim with the type-object `HasPropertySets` rewrite in
      // `step-property-sets.ts`, which writes the line this pass would
      // otherwise have written — hence injected rather than moved here.
      const mutated = ctx.applySourceLineMutations(
        expressId,
        entityText,
        entityRef.type,
        pass.modifiedAttributes.get(expressId),
        pass.sourceSchema,
        pass.overlayActive,
      );
      let nextEntityText = mutated.text;

      // A hidden PRODUCT's own line is already out of the export via
      // `allowedEntityIds`, and a TOMBSTONED entity's via `effective` — this
      // is the relationship that NAMED either one. `IFCREL*` is an
      // unconditional root (see `getVisibleEntityIds`), so its bytes reach
      // here unfiltered even when one of the ids they name was just
      // excluded; left alone that ships a `#N` with no `#N=` line, whether
      // the exclusion came from `visibleOnly` or from a plain deletion
      // (#2398). Checked before the nomination below: a relationship this
      // withholds must not also be counted as a delivered modification.
      //
      // Classified by the EFFECTIVE type (`effective.effectiveType`), not
      // the authored `entityType` above: a retype can move a record across
      // the `IFCREL*` boundary in either direction (`applySourceLineMutations`
      // already rewrote `nextEntityText` to the new class), and this check
      // has to agree with what actually got written, the same way
      // `getVisibleEntityIds` already does for the visibility walk itself.
      const effectiveRelType = pass.effective.effectiveType(expressId, entityRef.type).toUpperCase();
      if (mayNameExcludedRefs && effectiveRelType.startsWith('IFCREL')) {
        const filtered = filterHiddenRefsFromRelationshipLine(nextEntityText, pass.isExcludedFromRelationshipRefs);
        if (filtered === null) continue;
        nextEntityText = filtered;
      }

      // A retype or a positional edit that CHANGED the line is what makes
      // this entity count; a named attribute edit was already nominated by
      // the collection pass. Both flags report effect, so retyping an entity
      // to the class it already is — or writing a slot the token it already
      // holds — no longer claims a modification over a line the export left
      // byte-identical. This pass is full-export-only (`deltaOnly` skips it
      // wholesale), so nomination IS emission here and the kinds only have to
      // be right for the entity count — which is per entity, hence unchanged.
      if (mutated.retyped || mutated.positional) pass.modifiedEntities.add(expressId);
      if (mutated.retyped) pass.modifications.nominate(expressId, 'retype');
      if (mutated.positional) pass.modifications.nominate(expressId, 'positional');
      // The named-attribute kinds join them here rather than at their
      // collection sites, for the same reason and on the same signal (#2483).
      // This pass is full-export-only, so there is nothing to gate.
      nominateDeliveredInPlaceEdits(pass.modifications, expressId, mutated, pass.inPlaceNominees);

      // Apply schema conversion if exporting to a different schema version
      if (pass.converting) {
        const converted = convertStepLine(nextEntityText, pass.sourceSchema, pass.schema, options.guidRandom);
        if (converted !== null) {
          pass.entities.push(converted);
        }
        // null means entity should be skipped (no valid representation in target schema)
      } else {
        pass.entities.push(nextEntityText);
      }
    }
  }
}
