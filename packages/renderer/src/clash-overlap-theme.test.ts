/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The focused clash's overlap marks follow `OverlayTheme.clashOverlap` when
 * the caller omits a colour (#5490). Before, `clashA` / `clashB` /
 * `clashOverlap` were accepted by `setOverlayTheme` and read by nothing: every
 * caller passed its own RGBA and baked it in, so a theme switch while a clash
 * was focused left the previous theme's tint on screen.
 *
 * Same private-field injection as `clash-solid-overlay-wiring.test.ts`: the
 * GPU objects need a real device, so fakes record the colours they receive.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RendererOverlays, type OverlayHost } from './renderer-overlays.js';
import { DEFAULT_OVERLAY_THEME, type OverlayTheme, type Rgba } from './overlay-theme.js';
import type { ClashSolidInput } from './clash-solid-pipeline.js';

const DARK: OverlayTheme = { ...DEFAULT_OVERLAY_THEME, clashOverlap: [0.97, 0.46, 0.56, 1] };
const EXPLICIT: [number, number, number, number] = [0.1, 0.2, 0.3, 1];
const BOX = { min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number] };

function makeHarness() {
  const lineColors: Rgba[] = [];
  const solids: Array<ClashSolidInput | null> = [];
  const host: OverlayHost = {
    getModelBounds: () => null,
    expandModelBoundsWithFlatVertices: () => { /* not exercised */ },
    expandModelBoundsWithAnchoredLineVertices: () => { /* not exercised */ },
    syncCameraSceneBounds: () => { /* not exercised */ },
    requestRender: () => { /* not exercised */ },
  };
  const overlays = new RendererOverlays(host);
  const fields = overlays as unknown as Record<string, unknown>;
  fields['section2DOverlayRenderer'] = {
    setOverlayLineColor() { /* not asserted */ },
    setClashBoxLineColor(color: Rgba) { lineColors.push(color); },
    uploadClashBoxLines3D() { /* not asserted */ },
    clearClashBoxLines3D() { /* not asserted */ },
  };
  fields['clashSolidPipeline'] = {
    upload(input: ClashSolidInput | null) { solids.push(input); },
  };
  return { overlays, lineColors, solids };
}

describe('clash overlap marks follow the overlay theme (#5490)', () => {
  it('a box without a colour takes clashOverlap, and is recoloured by a later theme', () => {
    const h = makeHarness();
    h.overlays.setClashOverlapBox(BOX);
    assert.deepEqual(h.lineColors.at(-1), DEFAULT_OVERLAY_THEME.clashOverlap);
    h.overlays.setTheme(DARK);
    assert.deepEqual(h.lineColors.at(-1), DARK.clashOverlap);
  });

  it('contact lines without a colour take clashOverlap from the current theme', () => {
    const h = makeHarness();
    h.overlays.setTheme(DARK);
    h.overlays.setClashContactLines({ vertices: new Float32Array([0, 0, 0, 1, 0, 0]) });
    assert.deepEqual(h.lineColors.at(-1), DARK.clashOverlap);
  });

  it('an explicit colour wins and is not overwritten by a theme change', () => {
    const h = makeHarness();
    h.overlays.setClashOverlapBox({ ...BOX, color: EXPLICIT });
    const before = h.lineColors.length;
    h.overlays.setTheme(DARK);
    assert.equal(h.lineColors.length, before, 'setTheme must not touch an explicitly coloured box');
    assert.deepEqual(h.lineColors.at(-1), EXPLICIT);
  });

  it('a solid without a colour is uploaded in clashOverlap and re-uploaded on a theme change', () => {
    const h = makeHarness();
    const solid = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) };
    h.overlays.setClashIntersectionSolid(solid);
    assert.deepEqual(h.solids.at(-1)?.color, [...DEFAULT_OVERLAY_THEME.clashOverlap]);
    h.overlays.setTheme(DARK);
    assert.deepEqual(h.solids.at(-1)?.color, [...DARK.clashOverlap]);
    assert.equal(h.solids.at(-1)?.indices, solid.indices, 're-upload keeps the same geometry');
  });

  it('a cleared solid is not resurrected by a theme change', () => {
    const h = makeHarness();
    h.overlays.setClashIntersectionSolid({ positions: new Float32Array(9), indices: new Uint32Array([0, 1, 2]) });
    h.overlays.setClashIntersectionSolid(null);
    const before = h.solids.length;
    h.overlays.setTheme(DARK);
    assert.equal(h.solids.length, before);
  });
});
