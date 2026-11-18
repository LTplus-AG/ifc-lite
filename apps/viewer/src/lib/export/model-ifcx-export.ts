/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { Ifc5Exporter, type Ifc5ExportOptions } from '@ifc-lite/export';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { GeometryResult } from '@ifc-lite/geometry';
import type { FederatedModel } from '@/store/types';
import { modelIndices } from '@/lib/model-placement/model-indices';
/** Shared IFCX producer for the Export dialog, changed-model export and operations.
 * Every instanced occurrence is scoped to this model's renderer-ID bracket. */
export async function exportModelIfcx(input: {
  modelId: string; dataStore: IfcDataStore; geometryResult: GeometryResult | null | undefined;
  mutationView?: MutablePropertyView; idOffset: number; maxExpressId?: number;
  /** Loaded models, to resolve this model's renderer index: it separates a collab-joined model from one with an overlapping id range. */
  models: ReadonlyMap<string, FederatedModel>; options: Ifc5ExportOptions;
}) {
  const { withInstancedMeshes } = await import('../../utils/instancedExport.js');
  const geometry = input.geometryResult ? withInstancedMeshes(input.geometryResult,
    input.maxExpressId !== undefined ? { modelId: input.modelId, idOffset: input.idOffset, maxExpressId: input.maxExpressId,
      rendererModelIndex: modelIndices(input.models).get(input.modelId) } : null,
  ) : input.geometryResult;
  return new Ifc5Exporter(input.dataStore, geometry, input.mutationView, input.idOffset).export(input.options);
}
