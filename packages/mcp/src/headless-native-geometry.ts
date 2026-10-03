/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { GeometryProcessor, type CoordinateInfo, type MeshData } from '@ifc-lite/geometry';
import { StepExporter } from '@ifc-lite/export';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import type { ModellingStoreModelResolver } from '@ifc-lite/sdk';

/** One fresh current-overlay native pipeline for headless geometry commands. */
export async function withHeadlessGeometry<P, T>(model: ReturnType<ModellingStoreModelResolver>, prepare: (source: IfcDataStore) => P, consume: (prepared: P, meshes: readonly MeshData[], coord: CoordinateInfo | undefined) => T | Promise<T>): Promise<T> {
  const schema = model.store.schemaVersion ?? 'IFC4';
  const exported = new StepExporter(model.store, model.mutationView).export({ schema, applyMutations: true }).content;
  const source = await new IfcParser().parseColumnar(exported.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
  const prepared = prepare(source);
  const processor = new GeometryProcessor({ enableInstancing: false });
  try {
    await processor.init();
    const { meshes, coordinateInfo } = await processor.process(exported);
    return await consume(prepared, meshes, coordinateInfo);
  } finally { processor.dispose(); }
}
