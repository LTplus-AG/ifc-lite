/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * HBJSON export for `HeadlessBackend` (issue #1908).
 *
 * Split out of `headless-backend.ts` (already over the ~400-line module
 * guideline) rather than inlined there. HBJSON is rebuilt analytically from
 * IFC STEP bytes (rooms/openings/shades/constructions/adjacency) via the
 * wasm geometry engine. When the mutation view carries actual edits
 * (`mutationView.hasPendingChanges()` — e.g. `bim.store.addSpace` /
 * `bim.spaces.generate` ran earlier in this session), bytes are regenerated
 * through `StepExporter` first — the same mutation-view application the
 * `ifc:` STEP export adapter already uses in `headless-backend.ts` — so
 * overlay-authored entities (drawn spaces, in particular) are visible to the
 * analytic exporter. A mutation view with no pending changes (the common
 * case — `getOrCreateStoreEditor` can register a view before any edit lands,
 * e.g. `bim.store.removeEntity` on an id that doesn't exist still allocates
 * one) falls straight through to `store.source`, unchanged from before this
 * fix.
 *
 * `hasPendingChanges()`, not `hasChanges()`: the latter reads the
 * append-only `mutationHistory`, which `restoreNewEntity` repopulates
 * `newEntities` WITHOUT pushing to (it's the undo-of-delete path for an
 * overlay-created entity). `hasPendingChanges()` reads the current overlay
 * footprint instead — the same set `StepExporter` actually serializes — so a
 * restored overlay-created space is not silently missed.
 *
 * No IFC5/IFCX guard here (unlike the viewer's `resolveHbjsonMutationSource`,
 * which excludes `schemaVersion === 'IFC5'`): `loader.ts` only ever parses
 * with `IfcParser` (the STEP/columnar parser) and never constructs an
 * IFCX/IFC5 data store, so a CLI-loaded `IfcDataStore` cannot carry IFC5
 * content to regenerate in the first place. The `ifc:` STEP-export adapter
 * directly above this one in `headless-backend.ts` makes the same assumption
 * (it applies `mutationView` unconditionally, with no schema check).
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { GeometryProcessor } from '@ifc-lite/geometry';

export async function exportHbjson(
  store: IfcDataStore,
  mutationView: MutablePropertyView | null,
  name: string,
): Promise<string> {
  // The wasm HBJSON exporter is a whole-file consumer, so the bytes below are
  // the entire model either way. Everything downstream of `bytes` lives here so
  // the source can be handed over SCOPED (#2183) rather than materialised into
  // a variable that outlives the call.
  const runExport = async (bytes: Uint8Array): Promise<string> => {
    if (bytes.length === 0) {
      throw new Error('HBJSON export needs the source IFC bytes, which this store did not retain.');
    }
    const processor = new GeometryProcessor();
    try {
      await processor.init();
      const baseName = name.replace(/\.[^.]+$/, '');
      const result = processor.exportHbjson(bytes, baseName);
      if (result === null) {
        throw new Error('Geometry engine unavailable for HBJSON export.');
      }
      // The lens contract carries a string; HBJSON payloads are far below the
      // V8 string ceiling, so decoding here is safe.
      return new TextDecoder().decode(result);
    } finally {
      processor.dispose();
    }
  };

  if (mutationView && mutationView.hasPendingChanges() && store.source.byteLength > 0) {
    // StepExporter re-serializes un-mutated entities from `store.source` (via
    // EntityExtractor), so only attempt the regeneration when source bytes
    // are actually retained — otherwise fall through to the same clear error
    // below instead of silently emitting a degenerate STEP file.
    const schema = store.schemaVersion ?? 'IFC4';
    const exporter = new StepExporter(store, mutationView);
    return runExport(exporter.export({ schema }).content);
  }
  return store.source.withMaterializedAsync(runExport);
}
