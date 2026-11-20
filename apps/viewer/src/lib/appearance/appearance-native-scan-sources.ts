/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ViewerState } from '@/store';
import { getPointCloudScanSample } from '@/hooks/ingest/pointCloudScanCache';
import type { ScanSourceOption } from '@/components/viewer/appearance/useScanWorkbench';
/** The native source inventory shared by the Scan panel and operations. */
export function nativeAppearanceScanSources(models: ViewerState['models']): ScanSourceOption[] {
  return [...models.values()].flatMap((model) => {
    if (/\.glb$/i.test(model.sourceFile?.name ?? ''))
      return (model.geometryResult?.meshes ?? []).flatMap((mesh, index): ScanSourceOption[] =>
        mesh.textureRef && mesh.uvs
          ? [
              {
                id: `${model.id}:${index}`,
                modelId: model.id,
                selector: index,
                modelName: model.name,
                kind: 'surface',
                surfaceNumber: index + 1,
              },
            ]
          : [],
      );
    const retained =
      model.pointCloudHandleId === undefined || model.loadState === 'error'
        ? null
        : getPointCloudScanSample(model.pointCloudHandleId);
    return retained && retained.count >= 4
      ? [
          {
            id: `${model.id}:points`,
            modelId: model.id,
            selector: 'points',
            modelName: model.name,
            kind: 'points',
            retainedCount: retained.count,
            seenCount: retained.seen,
          },
        ]
      : [];
  });
}
