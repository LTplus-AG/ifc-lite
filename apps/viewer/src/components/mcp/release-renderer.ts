/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Hand a three.js renderer's WebGL context back to the browser on permanent
 * unmount — the tail of both `/mcp` scenes' `dispose()`.
 *
 * `WebGLRenderer.dispose()` releases three.js-side resources; it does **not**
 * ask the browser to relinquish the underlying drawing context, which is then
 * reclaimed only when the canvas is garbage-collected — non-deterministically.
 * A page gets roughly 16 live WebGL contexts and evicts the oldest when one is
 * requested past that, and `/mcp` is where that budget is under pressure: the
 * hero mounts on every visit, and `McpPlayground` unmounts `PlaygroundViewer`
 * whenever the 3D panel collapses and remounts it when reopened, so a long
 * session toggling the panel churns mount/unmount cycles (#2445). This is the
 * resource-exhaustion neighbour of #2401 / #2406: those made a *refused*
 * context degrade gracefully, this is about not manufacturing refusals.
 *
 * Order is load-bearing: dispose, then force the loss, then detach the canvas.
 * `forceContextLoss()` is a no-op where `WEBGL_lose_context` is unavailable
 * (three.js calls `loseContext()` only when `extensions.get()` returns one),
 * so it is safe on every device rather than a throw to guard against.
 *
 * The parameter is structural rather than `THREE.WebGLRenderer` for one
 * reason: no suite can construct a real renderer (happy-dom has no WebGL), so
 * typing the collaborator this way is what makes the sequence itself
 * reachable from CI. `THREE.WebGLRenderer` satisfies it as-is.
 */

export interface ReleasableRenderer {
  dispose(): void;
  forceContextLoss(): void;
  domElement: HTMLCanvasElement;
}

/** Dispose, release the GL context, and detach the canvas from `container`. */
export function releaseRenderer(renderer: ReleasableRenderer, container: HTMLElement): void {
  renderer.dispose();
  renderer.forceContextLoss();
  if (renderer.domElement.parentNode === container) {
    container.removeChild(renderer.domElement);
  }
}
