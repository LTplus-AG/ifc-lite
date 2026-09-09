/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { GeometryResult } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { exportGlbFromGeometry } from '@/lib/export/glb';
import { withInstancedMeshes, resolveInstancedExportGate } from '@/utils/instancedExport';

/** Quick exports use the same placed flat + instance geometry as the dialog. */
export function exportPlacedModelGlb(geometry: GeometryResult): Promise<Uint8Array> {
  const models = useViewerStore.getState().models;
  const owner = [...models].find(([, model]) => model.geometryResult === geometry)?.[0];
  const gate = resolveInstancedExportGate(owner, models);
  if (!gate.canExport) throw new Error('The export model is no longer loaded.');
  return exportGlbFromGeometry(withInstancedMeshes(geometry, gate.instancedModelRange), { includeMetadata: true });
}
