/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { generateIfcGuid } from '@ifc-lite/encoding';
import type { Renderer } from '@ifc-lite/renderer';
import type { AppearanceCommitOptions } from './command';
import { appearanceAssets, modelAppearanceAssets } from './model-assets';
import { createAppearancePlanner, type AppearancePlanner } from './planner-worker-client';
import type { CapturedMeshRequest } from './planner-types';
import { prepareAuthoredProduct } from './prepare-authored-product';
import { commitTexturedProduct } from './textured-product-command';

/** Region preparation owns the registration/selection guard. The mesh is an
 * immutable snapshot in workspace IFC Z-up metres, with IFC V-up UVs. */
export interface CapturedMeshSource {
  readonly assetId: string;
  readonly repeatS?: boolean;
  readonly repeatT?: boolean;
  readonly mesh: CapturedMeshRequest['mesh'];
  validate(): void;
}

export async function createIfcFromCapturedMesh(modelId: string, containerId: number,
  capture: CapturedMeshSource, renderer: Renderer,
  options: AppearanceCommitOptions & { Name?: string; planner?: AppearancePlanner } = {}) {
  if (options.signal?.aborted) throw new DOMException('Object creation cancelled.', 'AbortError');
  capture.validate();
  const input = capture.mesh;
  if ([input.positions.length, input.triangles.length, input.uvs.length].some(n => n === 0 || n > 200_000)
    || input.uvTriangles.length !== input.triangles.length) {
    throw new Error('Captured mesh needs 1..200000 position, triangle and UV rows, with one UV triangle per face');
  }
  if (input.positions.some(row => row.length !== 3) || input.triangles.some(row => row.length !== 3)
    || input.uvs.some(row => row.length !== 2) || input.uvTriangles.some(row => row.length !== 3)) {
    throw new Error('Captured rows need exactly three position/index values and two UV values.');
  }
  // Own numeric rows before the first await: a caller replacing or mutating its
  // capture cannot alter an in-flight native request halfway through creation.
  const mesh: CapturedMeshRequest['mesh'] = {
    positions: input.positions.map(p => [p[0], p[1], p[2]]), triangles: input.triangles.map(t => [t[0], t[1], t[2]]),
    uvs: input.uvs.map(uv => [uv[0], uv[1]]), uvTriangles: input.uvTriangles.map(t => [t[0], t[1], t[2]]),
  };
  const assetId = capture.assetId, repeatS = capture.repeatS ?? false, repeatT = capture.repeatT ?? false;
  const owner = { kind: 'draft' as const, id: crypto.randomUUID() };
  appearanceAssets.retain(assetId, owner);
  let planner: AppearancePlanner | undefined;
  try {
    const target = await prepareAuthoredProduct(modelId, options.signal, () => capture.validate());
    // Native planning receives target-source coordinates. Workspace translation
    // is applied by the renderer through its existing model placement transform.
    const [x, y, z] = target.translation;
    const positions: [number, number, number][] = mesh.positions.map(p => [p[0] - x, p[1] - y, p[2] - z]);
    planner = options.planner ?? createAppearancePlanner();
    const native = await planner.capturedMeshPlan(target.bytes, {
      schema: target.schema, sourceRevision: target.sourceRevision, nextExpressId: target.nextExpressId,
      containerId, GlobalId: generateIfcGuid(), containmentGlobalId: generateIfcGuid(),
      Name: options.Name?.trim() || 'Captured surface',
      imageUri: modelAppearanceAssets.getAuthoredUri(modelId, assetId),
      repeatS, repeatT, mesh: { ...mesh, positions },
    }, { signal: options.signal });
    target.validate();
    return await commitTexturedProduct(modelId, assetId, native, containerId, renderer, target.source, options);
  } finally {
    if (!options.planner) planner?.dispose();
    appearanceAssets.releaseOwner(owner);
  }
}
