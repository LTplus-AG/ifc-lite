/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #9507 - eased 3D wheel zoom. Driven by a fake clock and a manual frame
 * queue, so each assertion is about frames and milliseconds, not timing luck.
 * `step` records the camera travel the smoother asks for; the pose is a
 * counter the test can also bump to stand in for another control moving the
 * camera.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createWheelZoomSmoother,
  EASE_TAU_MS,
  MAX_BACKLOG_PX,
  MAX_STEP_PX,
  type WheelZoomInput,
} from './wheel-zoom-smoother.js';

const FRAME_MS = 1000 / 60;
const NOTCH = 100;

function rig(opts: { reducedMotion?: boolean } = {}) {
  let time = 0;
  let pose = 0;
  let nextHandle = 1;
  const frames = new Map<number, () => void>();
  const steps: number[] = [];
  let settles = 0;
  const smoother = createWheelZoomSmoother({
    step: (px) => { steps.push(px); pose++; },
    poseKey: () => String(pose),
    onSettle: () => { settles++; },
    reducedMotion: () => opts.reducedMotion ?? false,
    now: () => time,
    requestFrame: (cb) => { const h = nextHandle++; frames.set(h, cb); return h; },
    cancelFrame: (h) => { frames.delete(h); },
  });
  /** Advance the clock one frame and run the frame callbacks queued before it. */
  const frame = () => {
    time += FRAME_MS;
    const due = [...frames.values()];
    frames.clear();
    for (const cb of due) cb();
  };
  const runFrames = (n: number) => { for (let i = 0; i < n; i++) frame(); };
  const travel = () => steps.reduce((a, b) => a + b, 0);
  const push = (input: Partial<WheelZoomInput> & { px: number }) =>
    smoother.push({ eased: true, fastZoom: false, clientX: 400, clientY: 300, ...input });
  return {
    smoother, steps, push, frame, runFrames, travel,
    settles: () => settles,
    pendingFrames: () => frames.size,
    moveCameraElsewhere: () => { pose += 1000; },
  };
}

describe('wheel zoom smoother (#9507)', () => {
  it('starts a notch in the event itself and eases the rest over ~180 ms', () => {
    const r = rig();
    r.push({ px: NOTCH });
    const first = r.travel();
    assert.ok(first > 0, 'the response starts in the same frame');
    assert.ok(first < NOTCH * 0.5, `the first slice ${first} must not be the whole jump`);
    r.runFrames(Math.ceil((3 * EASE_TAU_MS) / FRAME_MS)); // three time constants
    assert.ok(r.travel() > NOTCH * 0.95, `95 % lands within 3 tau, got ${r.travel()}`);
    r.runFrames(30);
    assert.ok(Math.abs(r.travel() - NOTCH) < 1e-9, `the whole notch lands, got ${r.travel()}`);
    assert.equal(r.settles(), 1, 'one settle per finished zoom');
    assert.equal(r.pendingFrames(), 0, 'no frame keeps running after it settles');
  });

  it('never moves more than one notch in a step', () => {
    const r = rig();
    r.push({ px: 250, eased: false });
    for (let i = 0; i < 5; i++) r.push({ px: NOTCH });
    r.runFrames(60);
    for (const px of r.steps) assert.ok(Math.abs(px) <= MAX_STEP_PX, `step ${px}`);
  });

  it('caps a burst at the backlog, where the old per-event cap compounded', () => {
    // A fast spin: twenty notches inside one frame. The old path applied
    // 10 % for each of them (~88 % closer); the backlog keeps it to three notches.
    const r = rig();
    for (let i = 0; i < 20; i++) r.push({ px: NOTCH });
    r.runFrames(60);
    assert.ok(r.travel() <= MAX_BACKLOG_PX + NOTCH, `burst travel ${r.travel()} is bounded`);
    assert.ok(r.travel() >= MAX_BACKLOG_PX, `and still a real zoom: ${r.travel()}`);
  });

  it('applies continuous trackpad input at once, without a frame', () => {
    const r = rig();
    r.push({ px: 12, eased: false });
    assert.deepEqual(r.steps, [12]);
    assert.equal(r.pendingFrames(), 0);
    assert.equal(r.settles(), 1);
  });

  it('drains the part of a large continuous event above one notch over the next frames', () => {
    const r = rig();
    r.push({ px: 250, eased: false });
    assert.deepEqual(r.steps, [MAX_STEP_PX], 'one notch at once');
    r.runFrames(60);
    assert.ok(Math.abs(r.travel() - 250) < 1e-9, `the rest lands: ${r.travel()}`);
  });

  it('drops the queued zoom when the wheel reverses', () => {
    const r = rig();
    r.push({ px: NOTCH });
    const before = r.travel();
    r.push({ px: -NOTCH });
    r.runFrames(60);
    const afterReverse = r.steps.slice(1);
    assert.ok(afterReverse.every((px) => px < 0), 'nothing of the first notch lands after the reversal');
    assert.ok(Math.abs(r.travel() - (before - NOTCH)) < 1e-9, `net travel ${r.travel()}`);
  });

  it('cancels when another control moves the camera mid-ease', () => {
    const r = rig();
    r.push({ px: NOTCH });
    const count = r.steps.length;
    r.moveCameraElsewhere(); // an orbit, a pan, a preset view, fly
    r.runFrames(30);
    assert.equal(r.steps.length, count, 'no step after the foreign move');
    assert.equal(r.settles(), 1, 'the cancelled zoom still reports its end');
    assert.equal(r.smoother.pending(), 0);
  });

  it('applies everything at once under prefers-reduced-motion', () => {
    const r = rig({ reducedMotion: true });
    r.push({ px: 250 });
    assert.deepEqual(r.steps, [100, 100, 50]);
    assert.equal(r.pendingFrames(), 0);
    assert.equal(r.settles(), 1);
  });

  it('ignores zero and non-finite input', () => {
    const r = rig();
    r.push({ px: 0 });
    r.push({ px: Number.NaN });
    r.push({ px: Number.POSITIVE_INFINITY });
    assert.deepEqual(r.steps, []);
    assert.equal(r.settles(), 0);
  });

  it('still finishes when frames arrive with no time passing (a synchronous frame stub)', () => {
    let steps = 0;
    const smoother = createWheelZoomSmoother({
      step: () => { steps++; },
      poseKey: () => String(steps),
      onSettle: () => {},
      reducedMotion: () => false,
      now: () => 0,
      requestFrame: (cb) => { cb(); return 1; },
      cancelFrame: () => {},
    });
    smoother.push({ px: NOTCH, eased: true, fastZoom: false, clientX: 0, clientY: 0 });
    assert.equal(smoother.pending(), 0, 'the zoom settled');
    assert.ok(steps < 200, `in a bounded number of frames: ${steps}`);
  });

  it('stops stepping once disposed', () => {
    const r = rig();
    r.push({ px: NOTCH });
    const count = r.steps.length;
    r.smoother.dispose();
    r.runFrames(30);
    r.push({ px: NOTCH });
    assert.equal(r.steps.length, count);
    assert.equal(r.pendingFrames(), 0);
  });
});
