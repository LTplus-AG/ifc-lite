/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The slice of `Cesium.Model` this overlay touches. */
export type CesiumModelPrimitive = {
  modelMatrix: import('cesium').Matrix4;
  shadows?: import('cesium').ShadowMode;
  ready?: boolean;
  readyEvent?: { addEventListener(cb: () => void): () => void };
  destroy?: () => void;
};

/** A viewer lifetime can cancel readiness without pretending it timed out. */
export interface RenderableCancellation {
  isRetired(): boolean;
  onRetire(listener: () => void): () => void;
}

/**
 * Resolves once `model` can actually draw.
 *
 * `Model.fromGltfAsync` resolving only means the glTF was fetched and parsed:
 * Cesium finishes creating WebGL resources inside `update()` over subsequent
 * frames, raises `readyEvent` from `frameState.afterRender`, and then skips one
 * more frame before rendering. Waiting for the event plus a rendered frame is
 * what makes "swap without a visible gap" true rather than merely
 * "swap without an empty collection" (#2583).
 *
 * Rejects if neither happens within the timeout, so a model that never becomes
 * renderable cannot strand its predecessor on the globe for the session.
 */
export function whenModelRenderable(
  viewer: { scene: { requestRender(): void; postRender: { addEventListener(cb: () => void): () => void } }; },
  model: CesiumModelPrimitive,
  timeoutMs = 5_000,
  cancellation?: RenderableCancellation,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let done = false;
    let offCancel: (() => void) | undefined;
    const finish = (outcome: 'ready' | 'timeout' | 'cancelled') => {
      if (done) return;
      done = true;
      offReady?.();
      offFrame?.();
      offCancel?.();
      globalThis.clearTimeout(timer);
      if (outcome === 'ready') { resolve(); return; }
      if (outcome === 'cancelled') {
        reject(new Error('model readiness cancelled because its Viewer retired'));
        return;
      }
      // Bounded on purpose: the timeout path degrades to exactly the old
      // behaviour (drop the previous model and accept a brief blank), so a
      // model that is merely slow costs a flicker, not a stranded primitive.
      console.warn('[CesiumOverlay] model did not report renderable within %d ms; swapping anyway', timeoutMs);
      reject(new Error('model never became renderable'));
    };
    // One rendered frame AFTER ready — Cesium deliberately returns early from
    // the update that raises the event, so the model draws on the next one.
    const afterReady = (skipReadyFrame: boolean) => {
      offFrame = viewer.scene.postRender.addEventListener(() => {
        // Scene runs afterRender (and readyEvent) BEFORE postRender in the
        // same frame. That frame has not drawn the new model yet.
        if (skipReadyFrame) { skipReadyFrame = false; viewer.scene.requestRender(); return; }
        finish('ready');
      });
      viewer.scene.requestRender();
    };
    let offFrame: (() => void) | undefined;
    let offReady: (() => void) | undefined;
    const timer = globalThis.setTimeout(() => finish('timeout'), timeoutMs);
    if (cancellation?.isRetired()) { finish('cancelled'); return; }
    offCancel = cancellation?.onRetire(() => finish('cancelled'));
    if (model.ready) { afterReady(false); return; }
    if (!model.readyEvent) { finish('ready'); return; } // nothing to wait on
    offReady = model.readyEvent.addEventListener(() => { offReady?.(); afterReady(true); });
    viewer.scene.requestRender();
  });
}
