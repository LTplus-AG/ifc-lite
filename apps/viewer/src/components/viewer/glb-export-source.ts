/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Whether a GLB export can re-mesh STEP bytes in Rust, and which bytes.
 *
 * The from-bytes exporter re-meshes at full fidelity with rep-identity instancing
 * (50-85% smaller on repetitive models) and bounded memory on large inputs. It is
 * preferred whenever it can express the export exactly. Everything else takes the
 * from-meshes assembler over the meshes the viewer already holds.
 *
 * The bytes have to be the model as edited, not the file as loaded (#9026 item 18,
 * the same rule as `editedModelBytes` and the USD export). Reading the loaded file
 * made a Start blank session fail with "0 meshes" and made a loaded model silently
 * lose everything it authored and regain everything it deleted.
 */

import type { useViewerStore } from '@/store';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { displayedTranslation } from '@/lib/model-placement/state';

type ViewerState = ReturnType<typeof useViewerStore.getState>;

/** Reads the STEP bytes to re-mesh, or `null` when the held meshes must be used. */
export type GlbSourceBytes = (() => Promise<Uint8Array>) | null;

export function resolveGlbSourceBytes(
  state: Pick<ViewerState, 'models' | 'modelPlacement' | 'getMutationView'>,
  modelId: string,
  options: { colorSource: 'rendering' | 'shading'; mergeLayers: boolean },
): GlbSourceBytes {
  const model = state.models.get(modelId);
  const sourceFile = model?.sourceFile;
  // Only a plain .ifc handle re-meshes: cache restores have none, and .ifcx/.ifczip
  // go through different parsers.
  if (!model || !sourceFile || !/\.ifc$/i.test(sourceFile.name)) return null;
  // The exact engine's geometry is not the one a retained-kernel model has on screen.
  if (model.retainedGeometry) return null;
  // Shading substitution only exists on the viewer's MeshData.
  if (options.colorSource !== 'rendering') return null;
  // Re-meshing uses full fidelity and the file's frame: merged layers and a manual
  // workspace placement live only in the current meshes.
  if (options.mergeLayers) return null;
  if (displayedTranslation(state.modelPlacement, modelId).some((value) => value !== 0)) return null;
  // Node-extras expressIds stay consistent with the from-meshes output only here.
  if ((model.idOffset ?? 0) !== 0) return null;

  const view = state.getMutationView(modelId);
  if (!view?.hasPendingChanges()) return async () => new Uint8Array(await sourceFile.arrayBuffer());
  // Edits with no parsed source to re-serialize: the held meshes still show them.
  const store = model.ifcDataStore;
  if (!store || store.source.byteLength === 0) return null;
  return async () => editedModelBytes(store, view);
}
