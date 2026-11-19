/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { IfcParser } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { MergeModelInput } from './merged-exporter.js';
import type { IfcSchemaVersion } from './schema-converter.js';
import { hasGeorefEdits, isGeorefRefusal } from './step-coordinate-options.js';
import { StepExporter } from './step-exporter.js';

/**
 * True when a mutation view carries pending edits the exporter would bake.
 *
 * Keys off the view's *current overlay footprint* (`hasPendingChanges`), not the
 * append-only mutation history: the history never shrinks, so an
 * edited-then-undone model would keep reporting changes and force a redundant
 * re-bake. `hasPendingChanges` is a conservative over-approximation (the safe
 * direction here — under-reporting would silently drop edits). Falls back to the
 * legacy history/new-entity check for views that predate the method.
 */
function viewHasMutations(view: MutablePropertyView | undefined): boolean {
  if (!view) return false;
  if (typeof view.hasPendingChanges === 'function') return view.hasPendingChanges();
  // Legacy fallback (older MutablePropertyView without hasPendingChanges).
  const muts = typeof view.getMutations === 'function' ? view.getMutations() : [];
  if (muts.length > 0) return true;
  const created = typeof view.getNewEntities === 'function' ? view.getNewEntities() : [];
  return created.length > 0;
}

const GEOREF_NOT_WRITTEN = 'Georeferencing edits were not written.';

/** True when `model` carries edits that only a bake through {@link StepExporter} can apply. */
export function needsBake(model: MergeModelInput): boolean {
  return viewHasMutations(model.mutationView) || hasGeorefEdits(model.georefMutations);
}

/**
 * Bake each model's pending edits into its source bytes before merging.
 *
 * A model that {@link needsBake} is run through {@link StepExporter} in its own
 * source schema (mutations and georeference edits applied, geometry + quantities
 * kept), and the resulting bytes are re-parsed into a fresh data store. The merge
 * pipeline then sees the edited entities as ordinary source, so unit-aware
 * federation, GlobalId reconciliation and id offsetting are unaffected. Models
 * without edits pass through untouched (no export/parse cost).
 *
 * A georeference edit the exporter refuses (a partial position) or that
 * `targetSchema` cannot hold (IFC2X3) is left out and named in `warnings`, as
 * single-model export does; so is one it wrote only in part.
 */
export async function bakeMutatedModels(models: readonly MergeModelInput[], targetSchema: IfcSchemaVersion): Promise<{ models: MergeModelInput[]; warnings: string[] }> {
  const baked: MergeModelInput[] = [];
  const warnings: string[] = [];
  let parser: IfcParser | null = null;
  for (const model of models) {
    let georef = hasGeorefEdits(model.georefMutations) ? model.georefMutations : undefined;
    if (georef && targetSchema === 'IFC2X3') {
      warnings.push(`${model.name}: ${GEOREF_NOT_WRITTEN} IFC2X3 has no IfcProjectedCRS or IfcMapConversion.`);
      georef = undefined;
    }
    const sourceSchema = (model.dataStore.schemaVersion as IfcSchemaVersion) || 'IFC4';
    // Export in the SOURCE schema so no schema conversion happens here — the
    // merge loop still converts to the requested target schema per entity.
    // An IFC2X3 source cannot hold georeference edits, so with edits it bakes
    // in the target schema, as single-model export and section cropping do.
    const bakeSchema = georef && sourceSchema === 'IFC2X3' ? targetSchema : sourceSchema;
    const bake = (georefMutations: typeof georef) => new StepExporter(model.dataStore, model.mutationView).export({
      schema: georefMutations ? bakeSchema : sourceSchema,
      applyMutations: true,
      includeGeometry: true,
      includeQuantities: true,
      georefMutations,
    });
    let exported: ReturnType<typeof bake> | null = null;
    if (georef) {
      try { exported = bake(georef); } catch (error) {
        if (!isGeorefRefusal(error)) throw error;
        warnings.push(`${model.name}: ${GEOREF_NOT_WRITTEN} ${error.message}`);
      }
    }
    if (!exported && !viewHasMutations(model.mutationView)) {
      baked.push(model);
      continue;
    }
    exported ??= bake(undefined);
    for (const warning of exported.stats.georeferencingWarnings ?? []) warnings.push(`${model.name}: ${warning}`);
    parser = parser ?? new IfcParser();
    // slice() yields an exact-length ArrayBuffer-backed copy for the parser.
    const reparsed = await parser.parseColumnar(exported.content.slice().buffer, {
      disableWorkerScan: true,
    });
    baked.push({
      id: model.id,
      name: model.name,
      dataStore: reparsed,
      // Keep the caller's explicit unit scale (else the original store's) so
      // unit-aware federation is unaffected by the bake round-trip.
      lengthUnitScale: model.lengthUnitScale ?? model.dataStore.lengthUnitScale,
    });
  }
  return { models: baked, warnings };
}
