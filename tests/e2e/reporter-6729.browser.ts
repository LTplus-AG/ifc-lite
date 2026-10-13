/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Read real loaded state and drive existing camera/selection actions only.
// This module never loads, constructs or substitutes model geometry (#6729).
import { useViewerStore } from '../../apps/viewer/src/store/index.js';
import { getGlobalRenderer } from '../../apps/viewer/src/hooks/useBCF.js';
import { resolveEntityRef, resolveEntityRefGlobalId } from '../../apps/viewer/src/store/resolveEntityRef.js';
import type { CameraViewpoint } from '../../apps/viewer/src/store/types.js';
import { classifyViewportWitness } from './viewport-witness.js';

export const reporterNuts = [
  { alias: 'nutA', expressId: 193260, guid: '3Ah7yJN_vBpvGwujfqfj53' },
  { alias: 'nutB', expressId: 193266, guid: '0JNJzI9ezD2fgLYDAbsL$P' },
] as const;

export function readProbe() {
  const state = useViewerStore.getState();
  const renderer = getGlobalRenderer();
  const camera = renderer?.getCamera();
  const model = [...state.models.values()][0];
  const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-viewport="main"]');
  return {
    loading: state.loading, error: state.error, models: state.models.size,
    entityCount: model?.ifcDataStore?.entityCount ?? null, loadState: model?.loadState ?? null,
    meshCount: state.geometryResult?.meshes.length ?? 0,
    coordinateInfo: state.geometryResult?.coordinateInfo ?? null,
    identities: model ? reporterNuts.map(nut => {
      const globalId = state.toGlobalId(model.id, nut.expressId);
      const ref = resolveEntityRef(globalId);
      return { ...nut, globalId, resolved: ref, actualGuid: resolveEntityRefGlobalId(ref),
        actualName: model.ifcDataStore?.entities.getName(nut.expressId) ?? null };
    }) : [],
    selected: [...state.selectedEntities],
    adapter: renderer?.getAdapterInfo() ?? null,
    rendererDiagnostics: renderer?.getDiagnostics() ?? null,
    camera: camera ? {
      position: camera.getPosition(), target: camera.getTarget(), up: camera.getUp(),
      fov: camera.getFOV(), aspect: camera.getAspect(), distance: camera.getDistance(),
      projectionMode: camera.getProjectionMode(), orthoSize: camera.getOrthoSize(),
      sceneBounds: camera.getSceneBounds(), viewProjection: Array.from(camera.getViewProjMatrix().m),
      projection: Array.from(camera.getProjMatrix().m),
      // Renderer-owned relative frame is retained verbatim for later coordinate review.
      relativeFrame: { cameraWorld: camera.getRelativeToEyeFrame().getCameraWorld(),
        viewProjection: Array.from(camera.getRelativeToEyeFrame().getViewProjection().m),
        renderEpoch: camera.getRelativeToEyeFrame().getRenderEpoch() },
      clipEvidence: 'production view-projection matrix and scene bounds; numeric near/far not independently exposed',
    } : null,
    canvas: canvas ? { width: canvas.width, height: canvas.height,
      cssWidth: canvas.getBoundingClientRect().width, cssHeight: canvas.getBoundingClientRect().height,
      dpr: devicePixelRatio } : null,
  };
}

export function applyProbeView(view: CameraViewpoint): void {
  const state = useViewerStore.getState();
  if (!state.cameraCallbacks.applyViewpoint) throw new Error('Production camera callback unavailable');
  state.setProjectionMode(view.projectionMode);
  state.cameraCallbacks.applyViewpoint(view, false);
}

export function selectProbeNut(alias: 'unselected' | 'nutA' | 'nutB'): void {
  const state = useViewerStore.getState();
  if (alias === 'unselected') {
    state.setSelectedEntity(null);
    state.setSelectedEntityIds([]);
    state.setSelectedEntityId(null);
    return;
  }
  const nut = reporterNuts.find(row => row.alias === alias);
  const model = [...state.models.values()][0];
  if (!nut || !model || state.models.size !== 1) throw new Error('Authentic single-model nut mapping unavailable');
  const globalId = state.toGlobalId(model.id, nut.expressId);
  const ref = resolveEntityRef(globalId);
  if (ref.modelId !== model.id || ref.expressId !== nut.expressId || resolveEntityRefGlobalId(ref) !== nut.guid) {
    throw new Error('Canonical nut identity did not match immutable reporter fixture');
  }
  state.setSelectedEntity(ref);
  state.setSelectedEntityId(globalId);
  state.setSelectedEntityIds([globalId]);
}

export async function captureProbeFrame() {
  const host = globalThis as unknown as {
    __ifc_lite_capture_color_frame__?: () => Promise<string | null>;
  };
  const before = readProbe();
  const renderer = getGlobalRenderer();
  if (!renderer) throw new Error('Production renderer unavailable');
  const frame = await renderer.captureColorFrame();
  const witness = classifyViewportWitness({ frame, lossEvidence: null, strict: true });
  const png = await host.__ifc_lite_capture_color_frame__?.();
  if (!png?.startsWith('data:image/png;base64,')) throw new Error('Real production renderer color readback unavailable');
  return { before, after: readProbe(), png, witness };
}
