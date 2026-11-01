/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ContinuousRenderThrottle } from './continuousRenderThrottle.js';

/**
 * Drive the throttle the way useAnimationLoop does on a vsync grid of
 * `refreshMs` (+/- `jitterMs`, alternating) while every rendered frame costs
 * `costMs`, and return the settled rendered frame rate.
 */
function renderedFps(refreshMs: number, costMs: number, jitterMs = 0, seconds = 3): number {
  const throttle = new ContinuousRenderThrottle();
  let now = 0;
  let lastRender = -Infinity;
  const rendered: number[] = [];
  for (let frame = 0; now < seconds * 1000; frame++) {
    const delta = refreshMs + (frame % 2 === 0 ? jitterMs : -jitterMs);
    now += delta;
    throttle.noteFrameInterval(delta);
    if (throttle.allows(now - lastRender)) {
      throttle.noteRenderCost(costMs);
      lastRender = now;
      rendered.push(now);
    }
  }
  // Mean rendered interval after a one-second warm-up, as a frame rate.
  const settled = rendered.filter((t) => t > 1000);
  const meanInterval = (settled[settled.length - 1]! - settled[0]!) / (settled.length - 1);
  return Math.round(1000 / meanInterval);
}

describe('ContinuousRenderThrottle', () => {
  it('does not throttle cheap frames', () => {
    assert.equal(renderedFps(1000 / 60, 4), 60);
    assert.equal(renderedFps(1000 / 120, 4), 120);
  });

  // The old `elapsed < cap` gate rounded both the 25 ms and the 33 ms cap up
  // to every second vsync: exactly 30 fps on a 60 Hz display.
  it('leaves the 25 ms tier unthrottled on a 60 Hz display, even with rAF jitter', () => {
    assert.equal(renderedFps(1000 / 60, 18), 60);
    assert.equal(renderedFps(1000 / 60, 18, 0.4), 60);
  });

  it('renders the 25 ms tier at 40 fps on a 120 Hz display', () => {
    assert.equal(renderedFps(1000 / 120, 18), 40);
  });

  it('holds the 33 ms tier at a steady 30 fps on 60 Hz under jitter (the old gate flapped to 20)', () => {
    assert.equal(renderedFps(1000 / 60, 30), 30);
    assert.equal(renderedFps(1000 / 60, 30, 0.4), 30);
    assert.equal(renderedFps(1000 / 120, 30), 30);
  });

  it('reports the intended cadence for the effects governor', () => {
    const throttle = new ContinuousRenderThrottle();
    for (let i = 0; i < 8; i++) throttle.noteFrameInterval(1000 / 120);
    assert.equal(throttle.intervalMs(), 0);
    for (let i = 0; i < 20; i++) throttle.noteRenderCost(30);
    assert.equal(throttle.framesPerRender(), 4);
    assert.ok(Math.abs(throttle.intervalMs() - 4000 / 120) < 1e-9);
  });

  it('averages a zero-cost first sample instead of treating it as no sample', () => {
    const throttle = new ContinuousRenderThrottle();
    throttle.noteRenderCost(0);
    throttle.noteRenderCost(30); // average 6 ms: no cap, where restarting from 30 would engage 33 ms
    assert.equal(throttle.intervalMs(), 0);
  });

  it('steps down through the hysteresis ladder as frames get cheap again', () => {
    const throttle = new ContinuousRenderThrottle();
    for (let i = 0; i < 8; i++) throttle.noteFrameInterval(1000 / 120);
    for (let i = 0; i < 20; i++) throttle.noteRenderCost(30);
    assert.equal(throttle.framesPerRender(), 4, '33 ms tier');
    // 12 ms sits inside the hold band (10..14 ms): the 25 ms tier holds.
    for (let i = 0; i < 40; i++) throttle.noteRenderCost(12);
    assert.equal(throttle.framesPerRender(), 3, '25 ms tier');
    for (let i = 0; i < 40; i++) throttle.noteRenderCost(2);
    assert.equal(throttle.framesPerRender(), 1, 'released');
    assert.equal(throttle.intervalMs(), 0);
  });

  it('ignores a delta that only measured the previous render, not the display', () => {
    const throttle = new ContinuousRenderThrottle();
    for (let i = 0; i < 8; i++) throttle.noteFrameInterval(1000 / 120);
    for (let i = 0; i < 20; i++) {
      throttle.noteRenderCost(30);
      // A 33 ms delta right after a 30 ms render says nothing about refresh.
      throttle.noteFrameInterval(33);
    }
    assert.equal(throttle.framesPerRender(), 4, 'still judged against the 120 Hz refresh');
  });
});
