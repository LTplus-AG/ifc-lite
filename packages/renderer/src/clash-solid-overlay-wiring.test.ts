/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `RendererOverlays.setClashIntersectionSolid` wiring — same private-field
 * injection technique as `renderer-overlays-section.test.ts` (the pipeline
 * itself needs a real `GPUDevice` this test env doesn't have; `clash-solid-
 * pipeline.test.ts` covers its pure vertex-expansion logic directly).
 *
 * What this pins: `upload(null)` clears without requesting a render skip (it
 * still marks dirty, matching every other overlay clear in this file), a
 * non-null solid uploads AND requests a render, and `draw()` only calls
 * `render()` when the pipeline actually `hasGeometry()` — the same
 * `hasGeometry()`-gated pattern the fill/text pipelines use, so an empty
 * solid buffer never issues a zero-vertex draw call.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RendererOverlays, type OverlayHost } from './renderer-overlays.js';
import type { ClashSolidInput } from './clash-solid-pipeline.js';

function makeHarness() {
  const uploads: Array<ClashSolidInput | null> = [];
  let renders = 0;
  let requestRenders = 0;
  let geometry = false;

  const host: OverlayHost = {
    getModelBounds: () => null,
    expandModelBoundsWithFlatVertices: () => { /* not exercised */ },
    syncCameraSceneBounds: () => { /* not exercised */ },
    requestRender: () => { requestRenders += 1; },
  };

  const overlays = new RendererOverlays(host);

  const fakePipeline = {
    upload(input: ClashSolidInput | null) { uploads.push(input); },
    render() { renders += 1; },
    hasGeometry() { return geometry; },
  };
  (overlays as unknown as Record<string, unknown>)['clashSolidPipeline'] = fakePipeline;

  return {
    overlays,
    uploads,
    renderRequests: () => requestRenders,
    renderCalls: () => renders,
    setGeometry(v: boolean) { geometry = v; },
  } satisfies { overlays: RendererOverlays } & Record<string, unknown>;
}

const SOLID: ClashSolidInput = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  indices: new Uint32Array([0, 1, 2]),
  color: [1, 0.1, 0.85, 1],
};

describe('RendererOverlays.setClashIntersectionSolid', () => {
  it('uploads the solid and requests a render', () => {
    const h = makeHarness();
    h.overlays.setClashIntersectionSolid(SOLID);
    assert.deepEqual(h.uploads, [SOLID]);
    assert.equal(h.renderRequests(), 1);
  });

  it('passing null clears (uploads null) and still requests a render', () => {
    const h = makeHarness();
    h.overlays.setClashIntersectionSolid(SOLID);
    h.overlays.setClashIntersectionSolid(null);
    assert.deepEqual(h.uploads, [SOLID, null]);
    assert.equal(h.renderRequests(), 2);
  });

  it('draw() calls the pipeline render() only when hasGeometry() is true', () => {
    const h = makeHarness();
    const ctx = {
      options: {} as never,
      viewProj: new Float32Array(16),
      modelBounds: null,
      camera: {} as never,
      canvasWidth: 100,
      canvasHeight: 100,
    };
    const pass = {} as never; // draw() only reaches methods on the injected fakes below

    h.setGeometry(false);
    h.overlays.draw(pass, ctx);
    assert.equal(h.renderCalls(), 0, 'no geometry uploaded — must not issue a draw call');

    h.setGeometry(true);
    h.overlays.draw(pass, ctx);
    assert.equal(h.renderCalls(), 1);
  });
});
