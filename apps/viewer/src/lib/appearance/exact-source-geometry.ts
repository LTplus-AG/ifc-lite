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

/** Model-local product ids of `productIds` whose meshes in `meshes` lack corner provenance. */
function missingProducts(meshes: readonly MeshData[], productIds: ReadonlyMap<number, number>): number[] {
  const missing = new Set<number>();
  for (const mesh of meshes) {
    const product = productIds.get(mesh.expressId);
    if (product !== undefined && lacksCornerProvenance(mesh)) missing.add(product);
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
 * Wait until the scene draws `globalIds` from exact meshes; false on timeout. A piece still drawn from
 * records holds every product back; one re-meshed now (`remeshed`) also needs its provenance.
 */
async function sceneHasExactGeometry(globalIds: readonly number[], remeshed: ReadonlySet<number>, signal: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + SCENE_SWAP_WAIT_MS;
  const stale = (id: number, piece: MeshData) => piece.compact !== undefined || (remeshed.has(id) && lacksCornerProvenance(piece));
  for (;;) {
    signal.throwIfAborted();
    const scene = getGlobalRenderer()?.getScene();
    if (!scene) return true; // no viewport: binding needs one, and says so itself
    if (globalIds.every((id) => !(scene.getMeshDataPieces(id) ?? []).some((piece) => stale(id, piece)))) return true;
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
  const missing = missingProducts(meshes, byGlobalId);
  if (missing.length > 0) {
    const outcome = await requestRemesh(useViewerStore.getState, modelId, missing, 'shape');
    signal.throwIfAborted();
    const why = outcome.status !== 'applied' ? reasonOf(outcome)
      // Never re-mesh in a loop: what came back must carry the provenance, or the edit cannot bind.
      : missingProducts(useViewerStore.getState().models.get(modelId)?.geometryResult?.meshes ?? [], byGlobalId).length > 0
        ? 'the re-meshed geometry carries no corner provenance' : null;
    if (why !== null) {
      throw new Error(`The exact geometry of ${missing.length} object(s) could not be prepared for appearance (${why}). Refresh the preview, or reload the model.`);
    }
  }
  const remeshed = new Set(missing.map((id) => state.toGlobalId(modelId, id)));
  if (!await sceneHasExactGeometry([...byGlobalId.keys()], remeshed, signal)) {
    throw new Error('The exact geometry of the chosen objects is not in the 3D view yet. Refresh the preview.');
  }
}

/** The model-local products an appearance plan binds. */
export function planProductIds(plan: { items: readonly { productId: number }[] }): number[] {
  return [...new Set(plan.items.map((item) => item.productId))];
}
