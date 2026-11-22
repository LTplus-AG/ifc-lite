/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { GeometryProcessor } from '@ifc-lite/geometry';
import { StepExporter } from '@ifc-lite/export';
import { useViewerStore } from '@/store';
import type { SchemaVersion } from '@/store/types';
import { hasRetainedGeometryModel, RETAINED_EXACT_ONLY_REASON } from '@/store/retainedGeometry';
import { ensureModelExportReady } from '@/services/desktop-export';
import { resolveEnergyExportMutationSource } from '@/components/viewer/energy-export-source';
import { resolve as t } from '@/i18n/registry';
export class NoEnergyRoomsError extends Error {}

/** Exact native energy dialog producer; preserves skipped-space diagnostics. */
export async function produceNativeEnergy(selectedModel: { id: string; name: string; schemaVersion: SchemaVersion }, format: 'hbjson' | 'dfjson', checkpoint = () => {}) {
  if (hasRetainedGeometryModel(useViewerStore.getState().models)) throw new Error(t(RETAINED_EXACT_ONLY_REASON));
  checkpoint();
      const modelId = selectedModel.id;
      const exportDataStore = await ensureModelExportReady(modelId); checkpoint();
      if (!exportDataStore) {
        throw new Error(t('geometryExport.energy.modelDataUnavailableError'));
      }
      // Serialize the CURRENT model (with mutations applied) to IFC bytes so
      // in-app edits — e.g. spaces created by the Room tool — are in
      // the export; reading the retained source bytes alone would miss them.
      // Only when the overlay actually carries edits, though: a registered but
      // untouched view is the common case (the Properties panel,
      // `BulkPropertyEditor`, `DataConnector` and `ExportDialog` all construct
      // and register one just by being opened), and routing those through a
      // full STEP re-bake would make every export after opening any panel pay
      // for a regeneration that cannot change the output. See
      // `energy-export-source.ts`, and `energy-export.ts` for the CLI twin.
      const mutationSource = resolveEnergyExportMutationSource({
        mutationView: useViewerStore.getState().getMutationView(modelId),
        dataStore: exportDataStore,
        schemaVersion: selectedModel.schemaVersion,
      });
      // Strip only a real IFC source-file extension — a dotted display name
      // like `Tower.v2` must survive into the exported model name.
      const baseName = selectedModel.name.replace(/\.(ifc|ifcx|ifczip)$/i, '');

      // Set only for HBJSON when the export's `HbjsonStats.skipped > 0` (spaces dropped
      // as degenerate — malformed footprint / holes / non-extrusion): appended to the
      // success message below so a "successful" export that silently truncated the
      // model is never reported as a plain, unqualified success. Stays empty on a clean
      // export (nothing skipped) or for DFJSON (no stats contract).
      let hbjsonSkipNote = '';
      let hbjsonStats: { spaces: number; skipped: number } | null = null;

      // HBJSON comes back as UTF-8 bytes (not capped by the V8 max-string
      // ceiling); DFJSON models are small 2D plates, so that exporter stays
      // a string.
      const runExport = async (content: Uint8Array): Promise<Uint8Array | string> => {
        // A fresh processor is cheap: wasm-bindgen shares one module singleton,
        // so init() no-ops when the viewer already initialised the engine. It
        // owns a WASM `IfcLiteBridge` handle, so it must be freed on every path
        // out of this block, success or throw (AGENTS.md "Free every WASM handle
        // deterministically") — mirrors the CLI-side `runEnergyExport` helper.
        const processor = new GeometryProcessor();
        try {
          await processor.init(); checkpoint();
          if (format === 'hbjson') {
            const result = processor.exportHbjsonWithStats(content, baseName);
            if (result === null) {
              throw new Error(t('geometryExport.shared.geometryEngineUnavailableError'));
            }
            const { content: hbjson, stats } = result; hbjsonStats = stats;
            // A context-only HBJSON file can contain shades but no rooms.
            if (hbjson.length === 0 || stats.rooms === 0) {
              throw new NoEnergyRoomsError(t('geometryExport.energy.noIfcSpaceError'));
            }
            if (stats.skipped > 0) {
              hbjsonSkipNote = t('geometryExport.energy.skipNote', { skipped: stats.skipped, total: stats.spaces });
            }
            return hbjson;
          }
          const dfjson = processor.exportDfjson(content, baseName);
          if (dfjson === null) {
            throw new Error(t('geometryExport.shared.geometryEngineUnavailableError'));
          }
          // export_dfjson always returns a complete Model JSON, even with zero
          // spaces (empty `buildings`), so an emptiness check on the string can
          // never fire. Count the exported Room2Ds instead so a model without
          // IfcSpace volumes gets the same friendly error, not a useless file.
          const dfModel = JSON.parse(dfjson) as {
            buildings?: { unique_stories?: { room_2ds?: unknown[] }[] }[];
          };
          const roomCount = (dfModel.buildings ?? []).reduce(
            (n, b) => n + (b.unique_stories ?? []).reduce((m, s) => m + (s.room_2ds?.length ?? 0), 0),
            0,
          );
          if (roomCount === 0) {
            throw new NoEnergyRoomsError(t('geometryExport.energy.noIfcSpaceError'));
          }
          return dfjson;
        } finally {
          processor.dispose();
        }
      };

      let out: Uint8Array | string;
      if (mutationSource) {
        const sv = selectedModel.schemaVersion || 'IFC4';
        const schema = sv.includes('2X3') ? 'IFC2X3' : sv.includes('4X3') ? 'IFC4X3' : 'IFC4';
        const exporter = new StepExporter(mutationSource.dataStore, mutationSource.mutationView);
        out = await runExport(
          exporter.export({
            schema: schema as 'IFC2X3' | 'IFC4' | 'IFC4X3',
            includeGeometry: true,
            applyMutations: true,
            deltaOnly: false,
            application: 'ifc-lite',
          }).content,
        );
      } else {
        // Unedited (or IFC5, or source-less) model: hand the analytic exporter
        // the retained STEP bytes verbatim. `StepExporter` re-serializes
        // un-mutated entities from these same bytes, so when they are absent
        // there is nothing either path could have produced — fail loudly
        // rather than emit a structurally valid but empty energy model.
        if (!exportDataStore.source || exportDataStore.source.byteLength === 0) {
          throw new Error(
            t('geometryExport.energy.sourceBytesMissingError', { formatLabel: format.toUpperCase() }),
          );
        }
        // `IfcDataStore.source` is an accessor that may be block-compressed
        // (#2183), and both energy exporters are whole-file consumers, so the
        // contiguous view is borrowed SCOPED rather than hoisted into a
        // variable that outlives the export.
        out = await exportDataStore.source.withMaterializedAsync(runExport);
      }

      checkpoint(); return { blob: new Blob([out as BlobPart], { type: 'application/json' }), hbjsonSkipNote, stats: hbjsonStats };
}
