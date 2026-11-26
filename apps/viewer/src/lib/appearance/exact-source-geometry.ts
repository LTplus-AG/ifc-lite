/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Appearance on meshes that carry no canonical corner provenance.
 *
 * An appearance plan binds to a product's meshes through `appearanceSource`:
 * which canonical source corner each drawn corner is (`expandAppearanceCorners`).
 * A compact mesh (`?compactGeom`) has none. Its records decode re-welded on a
 * lattice, with triangles that collapse on it dropped, so a decode no longer
 * maps to source corners and the edit used to be refused.
 *
 * Once a plan names the products it will bind, those whose meshes lack the
 * provenance are re-meshed from the model's source by the authoring re-mesh
 * (`requestRemesh`): the same mesher the load used, so the meshes that come
 * back are the exact f32 meshes with the provenance a load without compact
 * records gives them. Only those products leave their pages.
 *
 * A scan transfer is not covered: its session pins the target model's
 * geometry from the first landmark pick, before any product is known.
 */

import type { MeshData } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { getGlobalRenderer } from '@/lib/renderer-ref';
import { isReleasedMesh } from '@/lib/released-mesh-provenance';
import { requestRemesh, type RemeshOutcome } from '@/lib/remesh/remesh-service';

/** How long the viewport may take to swap the re-meshed geometry in. */
const SCENE_SWAP_WAIT_MS = 30_000;
const SCENE_SWAP_POLL_MS = 50;

/**
 * A mesh appearance cannot bind to: drawn from compact records, or naming its
 * IFC item without corner provenance. Released CPU geometry (#10264) is left
 * to its own readback. Reads no geometry array, so a compact mesh is not decoded.
 */
function lacksCornerProvenance(mesh: MeshData): boolean {
  if (mesh.compact) return true;
  return mesh.geometryItemId !== undefined && mesh.appearanceSource === undefined && !isReleasedMesh(mesh);
}

function reasonOf(outcome: Exclude<RemeshOutcome, { status: 'applied' }>): string {
  if (outcome.status === 'refused') return outcome.reason;
  if (outcome.status === 'failed') return outcome.message;
  return 'the model changed';
}

const isCompact = (mesh: MeshData): boolean => mesh.compact !== undefined;

/** Model-local product ids of `productIds` with a mesh in `meshes` that `lacks` (default: no corner provenance). */
function missingProducts(meshes: readonly MeshData[], productIds: ReadonlyMap<number, number>, lacks = lacksCornerProvenance): number[] {
  const missing = new Set<number>();
  for (const mesh of meshes) {
    const product = productIds.get(mesh.expressId);
    if (product !== undefined && lacks(mesh)) missing.add(product);
  }
  return [...missing].sort((a, b) => a - b);
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
  });
}

/**
 * Wait until the scene draws every product in `expected` (global id -> how many meshes the model holds for
 * it) from at least that many pieces, none of them drawn from compact records; false on
 * timeout. A product the scene has fewer pieces of is mid-swap: the viewport removes the old pieces and adds
 * the re-meshed ones on its own commit.
 */
async function sceneHasExactGeometry(expected: ReadonlyMap<number, number>, signal: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + SCENE_SWAP_WAIT_MS;
  for (;;) {
    signal.throwIfAborted();
    const scene = getGlobalRenderer()?.getScene();
    if (!scene) return true; // no viewport: binding needs one, and says so itself
    const drawn = ([id, count]: [number, number]) => {
      const pieces = scene.getMeshDataPieces(id) ?? [];
      return pieces.length >= count && !pieces.some(isCompact);
    };
    if ([...expected].every(drawn)) return true;
    if (Date.now() >= deadline) return false;
    await abortableDelay(SCENE_SWAP_POLL_MS, signal);
  }
}

/**
 * Give the products a plan binds (`productIds`, model-local) the exact
 * geometry appearance needs, re-meshing those that lack it, and wait until the
 * viewport draws exact meshes for all of them: a run that finds the store
 * already exact (an earlier, aborted run re-meshed it) still waits for the
 * viewport's swap. Throws, saying why, when that cannot be done.
 */
export async function ensureExactSourceGeometry(modelId: string, productIds: readonly number[], signal: AbortSignal): Promise<void> {
  const state = useViewerStore.getState();
  const meshes = state.models.get(modelId)?.geometryResult?.meshes;
  if (!meshes?.length || productIds.length === 0) return;
  const byGlobalId = new Map(productIds.map((id) => [state.toGlobalId(modelId, id), id]));
  // Only products drawn from compact records (in the store, or still in the scene after an earlier, aborted
  // run re-meshed the store) are prepared. Without `?compactGeom` there are none, and the edit runs as before.
  const scene = getGlobalRenderer()?.getScene();
  const drawnCompact = [...byGlobalId.keys()].filter((id) => (scene?.getMeshDataPieces(id) ?? []).some(isCompact));
  const missing = missingProducts(meshes, byGlobalId, isCompact);
  if (missing.length === 0 && drawnCompact.length === 0) return;

  if (missing.length > 0) {
    const outcome = await requestRemesh(useViewerStore.getState, modelId, missing, 'shape');
    signal.throwIfAborted();
    const remeshed = new Map([...byGlobalId].filter(([, id]) => missing.includes(id)));
    const why = outcome.status !== 'applied' ? reasonOf(outcome)
      // Never re-mesh in a loop: what came back must carry the provenance, or the edit cannot bind.
      : missingProducts(useViewerStore.getState().models.get(modelId)?.geometryResult?.meshes ?? [], remeshed).length > 0
        ? 'the re-meshed geometry carries no corner provenance' : null;
    if (why !== null) {
      throw new Error(`The exact geometry of ${missing.length} object(s) could not be prepared for appearance (${why}). Refresh the preview, or reload the model.`);
    }
  }
  // Counted from the store as it is now: after a re-mesh it holds the exact meshes the viewport swaps in.
  const swapping = new Set([...missing.map((id) => state.toGlobalId(modelId, id)), ...drawnCompact]);
  const expected = new Map<number, number>();
  for (const mesh of useViewerStore.getState().models.get(modelId)?.geometryResult?.meshes ?? []) {
    if (swapping.has(mesh.expressId)) expected.set(mesh.expressId, (expected.get(mesh.expressId) ?? 0) + 1);
  }
  if (!await sceneHasExactGeometry(expected, signal)) {
    throw new Error('The exact geometry of the chosen objects is not in the 3D view yet. Refresh the preview.');
  }
}

/** The model-local products an appearance plan binds. */
export function planProductIds(plan: { items: readonly { productId: number }[] }): number[] {
  return [...new Set(plan.items.map((item) => item.productId))];
}
