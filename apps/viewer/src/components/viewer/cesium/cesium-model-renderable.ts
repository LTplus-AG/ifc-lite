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
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      offReady?.();
      offFrame?.();
      globalThis.clearTimeout(timer);
      if (ok) { resolve(); return; }
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
        finish(true);
      });
      viewer.scene.requestRender();
    };
    let offFrame: (() => void) | undefined;
    let offReady: (() => void) | undefined;
    const timer = globalThis.setTimeout(() => finish(false), timeoutMs);
    if (model.ready) { afterReady(false); return; }
    if (!model.readyEvent) { finish(true); return; } // nothing to wait on
    offReady = model.readyEvent.addEventListener(() => { offReady?.(); afterReady(true); });
    viewer.scene.requestRender();
  });
}
