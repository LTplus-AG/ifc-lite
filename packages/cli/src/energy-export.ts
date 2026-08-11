/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ladybug Tools energy-model export for `HeadlessBackend` — HBJSON (Honeybee)
 * and DFJSON (Dragonfly) (issues #1908, #1344).
 *
 * Split out of `headless-backend.ts` (already over the ~400-line module
 * guideline) rather than inlined there. Both formats are rebuilt analytically
 * from IFC STEP bytes via the wasm geometry engine — HBJSON as full
 * rooms/openings/shades/constructions, DFJSON as extruded `Room2D` plates —
 * so they differ only in which engine entry point consumes the bytes and how
 * the result is decoded. The byte-resolution step, the mutation gate and the
 * WASM handle lifecycle are therefore written once here and shared, rather
 * than duplicated per format (which is how DFJSON originally shipped reading
 * `store.source` directly, silently missing every in-session edit).
 *
 * When the mutation view carries actual edits
 * (`mutationView.hasPendingChanges()` — e.g. `bim.store.addSpace` /
 * `bim.spaces.generate` ran earlier in this session), bytes are regenerated
 * through `StepExporter` first — the same mutation-view application the
 * `ifc:` STEP export adapter already uses in `headless-backend.ts` — so
 * overlay-authored entities (drawn spaces, in particular) are visible to the
 * analytic exporter. A mutation view with no pending changes (the common
 * case — `getOrCreateStoreEditor` can register a view before any edit lands,
 * e.g. `bim.store.removeEntity` on an id that doesn't exist still allocates
 * one) falls straight through to `store.source`, unchanged.
 *
 * The non-regenerating path hands the source over SCOPED
 * (`withMaterializedAsync`, #2183) rather than materialising it into a
 * variable that outlives the call: `IfcDataStore.source` is an accessor that
 * may be block-compressed, so a whole-file consumer must borrow the
 * contiguous view for exactly the duration it needs it.
 *
 * `hasPendingChanges()`, not `hasChanges()`: the latter reads the
 * append-only `mutationHistory`, which `restoreNewEntity` repopulates
 * `newEntities` WITHOUT pushing to (it's the undo-of-delete path for an
 * overlay-created entity). `hasPendingChanges()` reads the current overlay
 * footprint instead — the same set `StepExporter` actually serializes — so a
 * restored overlay-created space is not silently missed.
 *
 * No IFC5/IFCX guard here (unlike the viewer's
 * `resolveEnergyExportMutationSource`, which excludes `schemaVersion ===
 * 'IFC5'`): `loader.ts` only ever parses with `IfcParser` (the STEP/columnar
 * parser) and never constructs an IFCX/IFC5 data store, so a CLI-loaded
 * `IfcDataStore` cannot carry IFC5 content to regenerate in the first place.
 * The `ifc:` STEP-export adapter in `headless-backend.ts` makes the same
 * assumption (it applies `mutationView` unconditionally, with no schema check).
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { GeometryProcessor } from '@ifc-lite/geometry';

/** Human-readable format name, used only to keep error messages format-specific. */
type EnergyFormat = 'HBJSON' | 'DFJSON';

/**
 * Resolve the IFC STEP bytes an energy exporter should consume and hand them
 * to `consume` SCOPED, then free the WASM `IfcAPI` handle on every path out —
 * success or throw (AGENTS.md "Free every WASM handle deterministically").
 *
 * Both engine entry points are whole-file consumers, so the bytes are the
 * entire model either way: the mutation view's regenerated output when it
 * carries edits, otherwise the retained source bytes borrowed for the
 * duration of the call.
 */
async function runEnergyExport<T>(
  store: IfcDataStore,
  mutationView: MutablePropertyView | null,
  format: EnergyFormat,
  consume: (processor: GeometryProcessor, bytes: Uint8Array) => T,
): Promise<T> {
  const withBytes = async (bytes: Uint8Array): Promise<T> => {
    if (bytes.length === 0) {
      throw new Error(`${format} export needs the source IFC bytes, which this store did not retain.`);
    }
    const processor = new GeometryProcessor();
    try {
      await processor.init();
      return consume(processor, bytes);
    } finally {
      processor.dispose();
    }
  };

  if (mutationView && mutationView.hasPendingChanges() && store.source.byteLength > 0) {
    // StepExporter re-serializes un-mutated entities from `store.source` (via
    // EntityExtractor), so only attempt the regeneration when source bytes
    // are actually retained — otherwise fall through to the same clear error
    // above instead of silently emitting a degenerate STEP file.
    const schema = store.schemaVersion ?? 'IFC4';
    const exporter = new StepExporter(store, mutationView);
    return withBytes(exporter.export({ schema }).content);
  }
  return store.source.withMaterializedAsync(withBytes);
}

/**
 * Export the model as HBJSON (Honeybee).
 *
 * `baseName` is used verbatim as the model identifier — the caller is
 * responsible for stripping a filename extension, because an explicit
 * `--name` is a display name in which dots are legitimate (`Tower.v2`).
 */
export async function exportHbjson(
  store: IfcDataStore,
  mutationView: MutablePropertyView | null,
  baseName: string,
): Promise<string> {
  return runEnergyExport(store, mutationView, 'HBJSON', (processor, bytes) => {
    const result = processor.exportHbjson(bytes, baseName);
    if (result === null) {
      throw new Error('Geometry engine unavailable for HBJSON export.');
    }
    // The lens contract carries a string; HBJSON payloads are far below the
    // V8 string ceiling, so decoding here is safe.
    return new TextDecoder().decode(result);
  });
}

/**
 * Export the model as DFJSON (Dragonfly): extruded `Room2D` plates grouped
 * into stories. See {@link exportHbjson} for the `baseName` contract.
 */
export async function exportDfjson(
  store: IfcDataStore,
  mutationView: MutablePropertyView | null,
  baseName: string,
): Promise<string> {
  return runEnergyExport(store, mutationView, 'DFJSON', (processor, bytes) => {
    // `export_dfjson` already returns a string (DFJSON models are small 2D
    // plates), so unlike HBJSON there is nothing to decode.
    const result = processor.exportDfjson(bytes, baseName);
    if (result === null) {
      throw new Error('Geometry engine unavailable for DFJSON export.');
    }
    return result;
  });
}
