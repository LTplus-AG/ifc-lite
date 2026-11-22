/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { Ifc5Exporter, type Ifc5ExportOptions } from '@ifc-lite/export';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { GeometryResult } from '@ifc-lite/geometry';
import type { FederatedModel } from '@/store/types';
import { modelIndices } from '@/lib/model-placement/model-indices';
type IfcxModelInput = {
  modelId: string; geometryResult: GeometryResult | null | undefined; idOffset: number; maxExpressId?: number;
  models: ReadonlyMap<string, FederatedModel>;
};

/**
 * The geometry an IFCX export of one model writes, read back first where released (#10264). It runs inside
 * the scoped `withReleasedExportGeometry` for exactly this model, so the collector sees the same model and
 * its preparation. Without a `maxExpressId`, a model the store knows still gets its own range (its bracket
 * and renderer index), never the unscoped null range the scoped preparation did not prepare.
 */
export async function withIfcxModelGeometry<T>(input: IfcxModelInput,
  produce: (geometry: GeometryResult | null | undefined) => T | Promise<T>): Promise<T> {
  const rendererModelIndex = modelIndices.assignedIndex(input.modelId);
  const { withInstancedMeshes, withReleasedExportGeometry } = await import('../../utils/instancedExport.js');
  return withReleasedExportGeometry((context) => {
    // A model the store knows always gets its own range; only the legacy single model (not in the map) keeps the
    // unscoped one, as before.
    const known = input.maxExpressId !== undefined || input.models.has(input.modelId);
    const range = known ? { modelId: input.modelId, idOffset: input.idOffset,
      maxExpressId: input.maxExpressId ?? input.models.get(input.modelId)?.maxExpressId ?? Number.MAX_SAFE_INTEGER - input.idOffset,
      rendererModelIndex } : null;
    return produce(input.geometryResult ? withInstancedMeshes(input.geometryResult, range, context) : input.geometryResult);
  }, [input.modelId]);
}

/** Shared IFCX producer for the Export dialog, changed-model export and operations.
 * Every instanced occurrence is scoped to this model's renderer-ID bracket. */
export async function exportModelIfcx(input: IfcxModelInput & {
  dataStore: IfcDataStore; mutationView?: MutablePropertyView;
  /** Loaded models, to resolve this model's renderer index: it separates a collab-joined model from one with an overlapping id range. */
  options: Ifc5ExportOptions;
}) {
  // Released CPU geometry (#10264) is read back first; resident geometry exports as before.
  return withIfcxModelGeometry(input, (geometry) =>
    new Ifc5Exporter(input.dataStore, geometry, input.mutationView, input.idOffset).export(input.options));
}
