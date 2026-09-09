/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { SceneContents } from '@ifc-lite/renderer';
import type { MeshData } from '@ifc-lite/geometry';

// Non-federated default: only the primary model (modelIndex 0, what
// `addInstancedShard` has always defaulted new templates to) survives a
// reshape when the caller has no per-model presence info.
const DEFAULT_PRESENT_INSTANCED_MODEL_INDICES: ReadonlySet<number> = new Set([0]);

/**
 * Reshape the scene for a non-streaming geometry change WITHOUT destroying
 * instanced templates that belong to a model still present (#2073). Clears
 * flat/batched geometry unconditionally (that always needs a full rebuild on
 * a reshape), then reconciles instanced ownership: any modelIndex the scene
 * still holds templates for but that is missing from
 * `presentInstancedModelIndices` gets torn down via
 * `removeInstancedTemplatesForModel` so a genuinely removed model's
 * repeated geometry does not linger on screen. See the
 * `presentInstancedModelIndices` param doc for the full rationale.
 */
export function reshapeSceneKeepingPresentInstanced(
  scene: SceneContents,
  presentInstancedModelIndices: ReadonlySet<number> | undefined,
  geometry: readonly MeshData[],
  appearanceSourceGeometry?: readonly MeshData[],
): void {
  const present = presentInstancedModelIndices ?? DEFAULT_PRESENT_INSTANCED_MODEL_INDICES;
  if (scene.clearFlatGeometryForRebuild) scene.clearFlatGeometryForRebuild(geometry, present, appearanceSourceGeometry);
  else scene.clearFlatGeometry();
  for (const modelIndex of scene.getInstancedModelIndices()) {
    if (!present.has(modelIndex)) {
      scene.removeInstancedTemplatesForModel(modelIndex);
    }
  }
}
