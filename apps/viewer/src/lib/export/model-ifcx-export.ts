/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { Ifc5Exporter, type Ifc5ExportOptions } from '@ifc-lite/export';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { GeometryResult } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { modelIndices } from '@/lib/model-placement/model-indices';
/** Shared IFCX producer for the Export dialog, changed-model export and operations.
 * Every instanced occurrence is scoped to this model's renderer-ID bracket. */
export async function exportModelIfcx(input: {
  modelId: string; dataStore: IfcDataStore; geometryResult: GeometryResult | null | undefined;
  mutationView?: MutablePropertyView; idOffset: number; maxExpressId?: number; options: Ifc5ExportOptions;
}) {
  const { withInstancedMeshes } = await import('../../utils/instancedExport.js');
  const geometry = input.geometryResult ? withInstancedMeshes(input.geometryResult,
    // The renderer index separates a collab-joined model from a loaded one with an overlapping id range.
    input.maxExpressId !== undefined ? { modelId: input.modelId, idOffset: input.idOffset, maxExpressId: input.maxExpressId,
      rendererModelIndex: modelIndices(useViewerStore.getState().models).get(input.modelId) } : null,
  ) : input.geometryResult;
  return new Ifc5Exporter(input.dataStore, geometry, input.mutationView, input.idOffset).export(input.options);
}
