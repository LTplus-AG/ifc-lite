/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { VisualEnhancementResolver, livePostEffects } from './visual-enhancement.js';

/**
 * Which post passes a frame runs (#5384, #5385). Ambient occlusion reads
 * only the depth attachment, so it no longer forces the object-id
 * attachment to be stored: the renderer keys that store on `edges` alone
 * (renamed from `separationLines`; the `separationLines` OPTION name is
 * unchanged, this is the resolved live-pass flag).
 */
describe('livePostEffects (#5384, #5385)', () => {
  const resolve = (opts: Parameters<VisualEnhancementResolver['resolve']>[0]) => new VisualEnhancementResolver().resolve(opts);

  it('runs AO at the requested quality while effects are live', () => {
    assert.equal(livePostEffects(resolve({ contactShading: { quality: 'low' } }), true).ambientOcclusion, 'low');
    assert.equal(livePostEffects(resolve({ contactShading: { quality: 'high' } }), true).ambientOcclusion, 'high');
    assert.equal(livePostEffects(resolve({ contactShading: { quality: 'off' } }), true).ambientOcclusion, null);
  });

  it('pauses every pass while the interaction governor has effects off', () => {
    const ve = resolve({ contactShading: { quality: 'low' }, separationLines: { enabled: true, quality: 'low' } });
    assert.deepEqual(livePostEffects(ve, false), { ambientOcclusion: null, edges: false });
    assert.deepEqual(livePostEffects(ve, true), { ambientOcclusion: 'low', edges: true });
  });

  it('honours the global switch', () => {
    const ve = resolve({ enabled: false, contactShading: { quality: 'high' }, separationLines: { enabled: true } });
    assert.deepEqual(livePostEffects(ve, true), { ambientOcclusion: null, edges: false });
  });

  it('keeps separation lines independent of AO', () => {
    const ve = resolve({ contactShading: { quality: 'low' }, separationLines: { enabled: false } });
    assert.deepEqual(livePostEffects(ve, true), { ambientOcclusion: 'low', edges: false });
    const off = resolve({ contactShading: { quality: 'off' }, separationLines: { enabled: true, quality: 'off' } });
    assert.deepEqual(livePostEffects(off, true), { ambientOcclusion: null, edges: false });
  });
});
