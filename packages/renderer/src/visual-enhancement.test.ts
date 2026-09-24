/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { VisualEnhancementResolver } from './visual-enhancement.js';

/**
 * The resolver is the one place the visual-enhancement options are brought
 * into range (#5384). `contactShading` is ambient occlusion now, and its
 * `radius` is a WORLD distance (0.05-10, metres for IFC models); it used to
 * be clamped to 1-3 PIXELS at the draw call. The separation-line and
 * intensity ranges moved here from the draw call unchanged.
 *
 * Literal ranges on purpose: the file imports only the resolver, so it also
 * runs against a tree where these clamps do not exist yet.
 */
describe('VisualEnhancementResolver ranges (#5384)', () => {
  it('keeps an AO radius in world units, clamped to 0.05-10', () => {
    const r = new VisualEnhancementResolver();
    assert.equal(r.resolve({ contactShading: { radius: 1.5 } }).contactShading.radius, 1.5);
    assert.equal(r.resolve({ contactShading: { radius: 4 } }).contactShading.radius, 4);
    assert.equal(r.resolve({ contactShading: { radius: 25 } }).contactShading.radius, 10);
    assert.equal(r.resolve({ contactShading: { radius: 0.001 } }).contactShading.radius, 0.05);
  });

  it('clamps both intensities to 0-1', () => {
    const r = new VisualEnhancementResolver();
    const high = r.resolve({ contactShading: { intensity: 3 }, separationLines: { intensity: 2 } });
    assert.equal(high.contactShading.intensity, 1);
    assert.equal(high.separationLines.intensity, 1);
    const low = r.resolve({ contactShading: { intensity: -1 }, separationLines: { intensity: -0.5 } });
    assert.equal(low.contactShading.intensity, 0);
    assert.equal(low.separationLines.intensity, 0);
    assert.equal(r.resolve({ contactShading: { intensity: 0.4 } }).contactShading.intensity, 0.4);
  });

  it('keeps the separation-line radius in pixels, clamped to 1-2', () => {
    const r = new VisualEnhancementResolver();
    assert.equal(r.resolve({ separationLines: { radius: 5 } }).separationLines.radius, 2);
    assert.equal(r.resolve({ separationLines: { radius: 0 } }).separationLines.radius, 1);
    assert.equal(r.resolve({ separationLines: { radius: 1.5 } }).separationLines.radius, 1.5);
  });

  it('keeps the previous value when a frame passes a non-finite one', () => {
    const r = new VisualEnhancementResolver();
    r.resolve({ contactShading: { radius: 2, intensity: 0.7 } });
    const next = r.resolve({ contactShading: { radius: Number.NaN, intensity: Number.POSITIVE_INFINITY } });
    assert.equal(next.contactShading.radius, 2);
    assert.equal(next.contactShading.intensity, 0.7);
  });

  it('still carries omitted options over from the previous frame', () => {
    const r = new VisualEnhancementResolver();
    r.resolve({ contactShading: { quality: 'high', radius: 0.5 } });
    const next = r.resolve({ separationLines: { enabled: false } });
    assert.equal(next.contactShading.quality, 'high');
    assert.equal(next.contactShading.radius, 0.5);
    assert.equal(next.separationLines.enabled, false);
  });
});
