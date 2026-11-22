/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { GeometryProcessor, type MeshData, type GeometryResult } from '@ifc-lite/geometry';
import { GEOM_CLASS_INSTANCED_TYPE } from '@ifc-lite/geometry/geometry-class';
import { useViewerStore } from '@/store';
import { hasRetainedShapeOnlyModel, RETAINED_SHAPE_ONLY_REASON } from '@/store/retainedGeometry';
import { buildHiddenIfcTypes, classFilterActive, isMeshTypeVisible } from '@/store/typeVisibilityFilter';
import { retypedClasses } from '@/lib/visibility/structural-view';
import { resolveExportVisibility } from '@/store/exportVisibility';
import { exportGlbFromGeometry } from './glb';
import { withInstancedMeshes, withReleasedExportGeometry, type ReleasedExportContext } from '@/utils/instancedExport';
import { modelIndices } from '@/lib/model-placement/model-indices';
import { resolveGlbSourceBytes } from '@/components/viewer/glb-export-source';
import { resolve as t } from '@/i18n/registry';
export interface NativeGlbSettings { visibleOnly: boolean; includeMetadata: boolean; lit: boolean; colorSource: 'rendering' | 'shading' }
/** The native dialog's exact source-versus-mesh assembler. Released CPU geometry (#10264) is read back first. */
export function produceNativeGlb(selectedModelId: string, selectedModel: { geometryResult: GeometryResult }, options: NativeGlbSettings, checkpoint = () => {}, onAssembler?: (fromSourceBytes: boolean) => void) {
  return withReleasedExportGeometry((context) => assembleNativeGlb(selectedModelId, selectedModel, options, checkpoint, onAssembler, context), [selectedModelId]);
}

async function assembleNativeGlb(selectedModelId: string, selectedModel: { geometryResult: GeometryResult }, options: NativeGlbSettings, checkpoint: () => void, onAssembler?: (fromSourceBytes: boolean) => void, context?: ReleasedExportContext) {
  const state = useViewerStore.getState(); const { typeVisibility, mergeLayers } = state;
  const live = state.models.get(selectedModelId);
  if (live && hasRetainedShapeOnlyModel(new Map([[selectedModelId, live]]))) throw new Error(t(RETAINED_SHAPE_ONLY_REASON));
  const { visibleOnly, includeMetadata, lit, colorSource } = options;
  let fromSourceBytes = false; checkpoint();
      // Assemble the GLB in Rust over the meshes the viewer already holds (no
      // re-meshing). Visibility + colour-source selection is applied here because
      // the Rust path emits exactly the meshes it is handed — this mirrors the
      // previous GLTFExporter `isMeshVisible` / `pickColor` semantics.
      //
      // Include this model's GPU-instanced occurrences, which are absent from its flat mesh list.
      const federatedModel = state.models.get(selectedModelId);
      const idOffset = federatedModel?.idOffset ?? 0;

      // Re-mesh the model's STEP bytes when that can express this export exactly,
      // else assemble from the meshes the viewer already holds.
      const readSourceBytes = resolveGlbSourceBytes(state, selectedModelId, { colorSource, mergeLayers });
      fromSourceBytes = readSourceBytes !== null; onAssembler?.(fromSourceBytes);

      let glb: Uint8Array;
      if (readSourceBytes) {
        const bytes = await readSourceBytes(); checkpoint();
        // `null`/`undefined` (no filter) must stay distinct from an empty-but-active
        // filter all the way to the wasm boundary — collapsing them here silently
        // exported the whole model when isolation matched nothing (#4328 follow-up).
        const toLocal = (set: Set<number> | null | undefined): Uint32Array | undefined => {
          if (set == null) return undefined;
          const out: number[] = [];
          for (const g of set) {
            const local = g - idOffset;
            if (local > 0) out.push(local);
          }
          return new Uint32Array(out);
        };
        const visibility = visibleOnly ? resolveExportVisibility(state, selectedModelId) : undefined;
        const hidden = (visibility && toLocal(visibility.hiddenGlobalIds)) ?? new Uint32Array();
        const isolated = visibility ? toLocal(visibility.isolatedGlobalIds) : undefined;
        const hiddenTypesCsv = visibleOnly
          ? [...buildHiddenIfcTypes(typeVisibility)].join(',')
          : '';
        const gp = new GeometryProcessor();
        try {
          await gp.init(); checkpoint();
          const out = gp.exportGlb(bytes, includeMetadata, hidden, isolated, hiddenTypesCsv, lit);
          if (!out) throw new Error(t('geometryExport.shared.geometryEngineUnavailableError'));
          glb = out;
        } finally {
          gp.dispose();
        }
      } else {
        // GPU instancing stopped being primary-only on 2026-08-06 (#2255) — a
        // federated model can carry instanced occurrences too, re-homed onto
        // its own global id space at drain. `getAllInstancedMeshData()`
        // returns every loaded model's occurrences unfiltered, so scope it to
        // THIS model's `{ idOffset, maxExpressId }` bracket (both on
        // `FederatedModel`) rather than the old primary-only gate, or a
        // federation of N models would splice every other model's instanced
        // entities into this one's export too. `federatedModel` is undefined
        // only for the legacy `__legacy__` slot, which is provably the sole
        // model loaded — nothing else to wrongly include, so `null` (no
        // filter) is correct there (#2865/#2878 follow-up).
        // Released CPU geometry (#10264) is read back first (see the export entry's context).
        const exportGeometry = withInstancedMeshes(
          selectedModel.geometryResult,
          federatedModel
            ? { modelId: federatedModel.id, idOffset: federatedModel.idOffset ?? 0, maxExpressId: federatedModel.maxExpressId ?? 0,
              rendererModelIndex: modelIndices(state.models).get(federatedModel.id) } // as model-ifcx-export: excludes an overlapping-id collab model
            : null,
          context,
        );
        const visibility = visibleOnly ? resolveExportVisibility(state, selectedModelId) : undefined;
        const globalHidden = visibility?.hiddenGlobalIds;
        const globalIsolated = visibility?.isolatedGlobalIds;
        const retyped = visibleOnly && classFilterActive(typeVisibility) ? retypedClasses(state) : undefined;
        // `globalIsolated` is `null` for "no filter" vs an empty-but-non-null `Set`
        // for "isolation active, matches nothing" (`resolveExportVisibility`) — a
        // `.size > 0` check here would collapse the two and export the whole model
        // when isolation matched nothing (#4328 follow-up). `!= null` catches both
        // `null` (no filter) and `undefined` (`!visibleOnly`).
        const hasIsolation = globalIsolated != null;
        const meshes = (exportGeometry.meshes as MeshData[])
          .filter((m) => {
            // Instanced type-library duplicates repeat occurrence geometry at the
            // origin; the from-bytes assembler excludes them (mesh_visible), as must this.
            if (m.geometryClass === GEOM_CLASS_INSTANCED_TYPE) return false;
            if (!visibleOnly) return true;
            if (!isMeshTypeVisible(m, typeVisibility, undefined, retyped)) return false;
            if (hasIsolation && !globalIsolated!.has(m.expressId)) return false;
            if (globalHidden && globalHidden.has(m.expressId)) return false;
            return true;
          })
          .map((m) =>
            colorSource === 'shading' && m.shadingColor
              ? ({ ...m, color: m.shadingColor } as MeshData)
              : m,
          );
        glb = await exportGlbFromGeometry(exportGeometry, { meshes, includeMetadata, lit });
      }

      checkpoint(); return { blob: new Blob([new Uint8Array(glb)], { type: 'model/gltf-binary' }), fromSourceBytes };
}
