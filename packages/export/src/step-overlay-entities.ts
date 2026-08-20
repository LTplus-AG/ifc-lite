/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The overlay-created-entities phase of `StepExporter.export()` (#2475 step
 * 2e): the pass that writes one line per entity the OVERLAY created
 * (`store.addEntity` / `mutationView.createEntity`), as opposed to
 * `step-source-iteration.ts`, which writes lines for records the SOURCE file
 * already holds.
 *
 * It runs last among the four output passes — after georeferencing
 * (`step-georeferencing.ts`), property/quantity-set generation
 * (`step-property-sets.ts`) and source iteration — and reads what two of them
 * wrote: `pass.modifiedAttributes` (attribute-collection phase, applied here
 * as an overlay-created entity's post-create edits) and
 * `pass.overlayTypeOwnedPsets` (`step-property-sets.ts`, a created TYPE
 * object's generated pset ids, arriving as one more positional override).
 * Nothing downstream of this phase reads anything it writes except the
 * settle/assemble tail, so it moves cleanly.
 *
 * What is injected rather than moved, and why: `applyOverlayEntityOverrides`
 * stays on `StepExporter` because it calls the two `serializeNamedAttribute`
 * / `serializePositionalOverride` helpers, which have no other reader in this
 * phase's region and were left in place by step 2d for the same reason.
 * `isGeometryEntity` is shared with the setup closure and with
 * `step-source-iteration.ts`. `relationshipWithheldWarning` is the same pure
 * string formatter `step-source-iteration.ts` already injects, not
 * duplicated here.
 *
 * `mutationView` is passed through as-is (not narrowed to an interface of the
 * three optional methods this phase calls) because the original code guards
 * every one of them with its own `typeof x === 'function'` check rather than
 * assuming the shape — a real-store `MutablePropertyView` versus a bare mock
 * used by some tests. Narrowing the type here would not remove those checks
 * without also changing what a test double is allowed to omit.
 */

import type { IfcAttributeValue } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { filterHiddenRefsFromRelationshipLine } from './reference-collector.js';
import { convertStepLine } from './schema-converter.js';
import { retypeArgTokens } from './retype.js';
import { HAS_PROPERTY_SETS_SLOT } from './type-owned-psets.js';
import { serializeEntityArgs, serializeAttributeSlot } from './attribute-real-slots.js';
import type { ExportPass, StepExportOptions } from './step-exporter.js';

/**
 * The exporter state this phase cannot read off the {@link ExportPass}.
 */
export interface OverlayEntitiesContext {
  readonly mutationView: MutablePropertyView | null;
  /** `StepExporter.applyOverlayEntityOverrides`: resolves named/positional
   *  overrides against the overlay-created entity's EFFECTIVE class. Kept on
   *  the exporter because it calls the private serialize helpers. */
  readonly applyOverlayEntityOverrides: (
    argsText: string,
    entityType: string,
    attributeOverrides: Map<string, string> | null,
    positionalOverrides: Map<number, IfcAttributeValue> | null,
    schemaVersion: ExportPass['sourceSchema'],
    onRejected?: (attrName: string, value: string) => void,
  ) => string;
  /** `StepExporter.isGeometryEntity`, also read by the setup closure and by
   *  `step-source-iteration.ts`. */
  readonly isGeometryEntity: (type: string) => boolean;
  /** The `relationshipWithheldWarning` message builder (`step-exporter.ts`):
   *  a pure string formatter with no pass dependency, injected here as it is
   *  into `step-source-iteration.ts`. */
  readonly relationshipWithheldWarning: (expressId: number, type: string) => string;
}

/**
 * Add overlay-created entities (store.addEntity / mutationView.createEntity).
 * Apply the same filters as the source-iteration pass so newly-created
 * beams/slabs don't smuggle their geometry helpers (IfcCartesianPoint,
 * IfcExtrudedAreaSolid, etc.) past `includeGeometry:false` /
 * `exportPropertiesOnly()` modes.
 */
export function writeOverlayCreatedEntities(
  pass: ExportPass,
  options: StepExportOptions,
  excludeGeometry: boolean,
  applyMutations: boolean,
  mayNameOmittedRefs: boolean,
  isOmittedFromOutput: (id: number) => boolean,
  ctx: OverlayEntitiesContext,
): void {
  if (
    !ctx.mutationView
    || !applyMutations
    || typeof ctx.mutationView.getNewEntities !== 'function'
  ) {
    return;
  }
  const getTypeMut = typeof ctx.mutationView.getEntityTypeMutation === 'function'
    ? ctx.mutationView.getEntityTypeMutation.bind(ctx.mutationView)
    : null;
  for (const entity of ctx.mutationView.getNewEntities()) {
    // A retyped overlay entity keeps its AUTHORED type on `entity.type`
    // (the overlay typeMutation is the source of truth for the effective
    // class). Resolve the effective class, then re-lay-out the authored
    // attributes from the authored layout up to it.
    const typeMut = getTypeMut ? getTypeMut(entity.expressId) : null;
    const effectiveType = typeMut?.newType ?? entity.type;
    // STEP requires UPPERCASE entity type tokens; the upper-case happens
    // here at the file-format boundary.
    const upperType = effectiveType.toUpperCase();
    if (excludeGeometry && ctx.isGeometryEntity(upperType)) {
      continue;
    }
    if (pass.allowedEntityIds !== null && !pass.allowedEntityIds.has(entity.expressId)) {
      continue;
    }
    // Re-lay-out by name against the effective class (identity for
    // compatible layouts). Runs whenever a retype intent exists — even a
    // same-class retype, which carries a PredefinedType override
    // (e.g. setEntityType(id, 'IfcColumn', 'PILASTER')).
    let argsText: string;
    if (typeMut) {
      // Serialize against the AUTHORED layout (`entity.type`); retypeArgTokens
      // then re-lays the tokens out by name up to the effective class.
      const srcTokens = entity.attributes.map(
        (value, i) => serializeAttributeSlot(entity.type, i, value, pass.sourceSchema),
      );
      const { tokens } = retypeArgTokens(
        srcTokens,
        entity.type,
        effectiveType,
        typeMut.predefinedType ?? null,
        pass.sourceSchema,
      );
      argsText = tokens.join(',');
    } else {
      argsText = serializeEntityArgs(entity.type, entity.attributes, pass.sourceSchema);
    }
    // Edits made AFTER the create live in the overlay, never in the
    // authored payload (#2006). The source-iteration pass applies them to
    // source records via applyAttributeMutations / applyPositionalMutations;
    // an overlay-created entity has no source record, so without this it was
    // written from its creation payload alone and every later
    // `setAttribute` / `setPositionalAttribute` was silently dropped on
    // save — data loss with no error and no warning.
    //
    // Order mirrors the source pass: retype (above) -> named attributes ->
    // positional overrides, all resolved against the EFFECTIVE class.
    const attributeOverrides = pass.modifiedAttributes.get(entity.expressId) ?? null;
    const queuedPositional = typeof ctx.mutationView.getPositionalMutationsForEntity === 'function'
      ? ctx.mutationView.getPositionalMutationsForEntity(entity.expressId)
      : null;
    // A created TYPE object owns its psets through HasPropertySets, and the
    // ids of the psets this export generated are only known now — so they
    // arrive as one more slot override rather than through the overlay.
    // `has`, not `??`, for the same reason `overlaySlotValue` gives: the
    // stored value is deliberately null when the resolved list is empty.
    const positionalOverrides = pass.overlayTypeOwnedPsets.has(entity.expressId)
      ? new Map(queuedPositional).set(
          HAS_PROPERTY_SETS_SLOT,
          pass.overlayTypeOwnedPsets.get(entity.expressId) ?? null,
        )
      : queuedPositional;
    if (
      (attributeOverrides && attributeOverrides.size > 0)
      || (positionalOverrides && positionalOverrides.size > 0)
    ) {
      argsText = ctx.applyOverlayEntityOverrides(
        argsText,
        upperType,
        attributeOverrides,
        positionalOverrides,
        pass.sourceSchema,
        // Overlay-created entities report a rejected REAL edit exactly as
        // source-backed ones do. Without this the slot was kept and NOTHING
        // was said - the silent discard this whole change exists to
        // prevent, surviving in the one path that had no test.
        (attr, value) =>
          pass.warnings.push(
            `entity #${entity.expressId}: attribute ${attr} not written - ` +
              `${JSON.stringify(value)} is not a number and the slot is REAL-typed`,
          ),
      );
    }
    let line: string | null = `#${entity.expressId}=${upperType}(${argsText});`;
    // Same gap as the source-iteration pass, for an overlay-authored
    // relationship instead of a parsed one (#2398).
    //
    // `mayNameOmittedRefs` is provably TRUE wherever this line executes:
    // the block enclosing this pass requires `ctx.mutationView` and
    // `applyMutations`, which is `pass.overlayActive`, which is one of the
    // gate's own disjuncts. Spelled out anyway so both filter sites read the
    // same — the previous gate's failure was one site's condition drifting
    // from what the filter needed, and a pass reachable without an overlay
    // would otherwise silently need the gate re-derived here.
    if (mayNameOmittedRefs && upperType.startsWith('IFCREL')) {
      line = filterHiddenRefsFromRelationshipLine(line, isOmittedFromOutput);
      if (line === null) {
        pass.warnings.push(ctx.relationshipWithheldWarning(entity.expressId, upperType));
        continue;
      }
    }
    if (pass.converting) {
      const converted = convertStepLine(line, pass.sourceSchema, pass.schema, options.guidRandom);
      if (converted !== null) {
        pass.entities.push(converted);
        pass.newEntityCount++;
      }
    } else {
      pass.entities.push(line);
      pass.newEntityCount++;
    }
  }
}
