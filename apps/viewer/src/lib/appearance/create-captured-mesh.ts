/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { generateIfcGuid } from '@ifc-lite/encoding';
import type { Renderer } from '@ifc-lite/renderer';
import type { AppearanceCommitOptions } from './command';
import { appearanceAssets, modelAppearanceAssets } from './model-assets';
import { createAppearancePlanner, type AppearancePlanner } from './planner-worker-client';
import type { CapturedMeshRequest } from './planner-types';
import { prepareTexturedProduct } from './prepare-textured-product';
import { commitTexturedProduct } from './textured-product-command';

/** Region preparation owns the registration/selection guard. The mesh is an
 * immutable snapshot in workspace IFC Z-up metres, with IFC V-up UVs. */
export interface CapturedMeshSource {
  readonly assetId: string;
  readonly mesh: CapturedMeshRequest['mesh'];
  validate(): void;
}

export async function createIfcFromCapturedMesh(modelId: string, containerId: number,
  capture: CapturedMeshSource, renderer: Renderer,
  options: AppearanceCommitOptions & { Name?: string; planner?: AppearancePlanner } = {}) {
  capture.validate();
  const owner = { kind: 'draft' as const, id: crypto.randomUUID() };
  appearanceAssets.retain(capture.assetId, owner);
  let planner: AppearancePlanner | undefined;
  try {
    const target = await prepareTexturedProduct(modelId, options.signal, () => capture.validate());
    // Native planning receives target-source coordinates. Workspace translation
    // is restored exactly once by the shared canonical-mesh publication path.
    const [x, y, z] = target.translation;
    const positions: [number, number, number][] = capture.mesh.positions.map(p => [p[0] - x, p[1] - y, p[2] - z]);
    planner = options.planner ?? createAppearancePlanner();
    const native = await planner.capturedMeshPlan(target.bytes, {
      schema: target.schema, sourceRevision: target.sourceRevision, nextExpressId: target.nextExpressId,
      containerId, GlobalId: generateIfcGuid(), containmentGlobalId: generateIfcGuid(),
      Name: options.Name?.trim() || 'Captured surface',
      imageUri: modelAppearanceAssets.getAuthoredUri(modelId, capture.assetId),
      mesh: { ...capture.mesh, positions },
    }, { signal: options.signal });
    target.validate();
    return await commitTexturedProduct(modelId, capture.assetId, native, containerId, renderer, target.source, options);
  } finally {
    if (!options.planner) planner?.dispose();
    appearanceAssets.releaseOwner(owner);
  }
}
