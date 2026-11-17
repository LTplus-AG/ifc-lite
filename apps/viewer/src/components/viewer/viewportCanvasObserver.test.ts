/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { MeasureCameraState } from './measureCameraState';
import { observeViewportCanvas } from './viewportCanvasObserver';

/**
 * #9002: the Viewport's canvas ResizeObserver must feed its reports to
 * measureCanvasBoxWatch, or a resize that keeps the aspect no longer ends Point
 * mode's Live (#8886). A stand-in observer records what the helper wires up;
 * the canvas is a plain token, never a DOM node.
 */
type Entries = ReadonlyArray<{ contentRect: { width: number; height: number } }>;

const original = globalThis.ResizeObserver;
let observers: FakeObserver[] = [];
let rejectDevicePixelBox = false;

class FakeObserver {
  readonly boxes: string[] = [];
  constructor(readonly callback: (entries: Entries) => void) { observers.push(this); }
  observe(_target: unknown, options?: { box?: string }) {
    if (options?.box === 'device-pixel-content-box' && rejectDevicePixelBox) throw new TypeError('unsupported box');
    this.boxes.push(options?.box ?? 'content-box');
  }
  disconnect() {}
  unobserve() {}
}

function setup() {
  observers = [];
  globalThis.ResizeObserver = FakeObserver as unknown as typeof ResizeObserver;
  const ref = { current: null as MeasureCameraState | null };
  let renders = 0;
  observeViewportCanvas({} as HTMLCanvasElement, ref, () => { renders++; });
  assert.equal(observers.length, 1, 'expected one observer');
  const report = (width: number, height: number) => observers[0].callback([{ contentRect: { width, height } }]);
  return { ref, report, renders: () => renders, observer: observers[0] };
}

const LAST_PASS = { canvasWidth: 1600, canvasHeight: 800 } as MeasureCameraState;

afterEach(() => {
  globalThis.ResizeObserver = original;
  rejectDevicePixelBox = false;
});

describe('viewport canvas ResizeObserver wiring (#9002)', () => {
  it('a resize that keeps the aspect forgets the last measure pass; the same box keeps it', () => {
    const { ref, report, renders } = setup();
    report(800, 400); // the observer's first report
    ref.current = LAST_PASS;
    report(800, 400); // pixel ratio only: same CSS box
    assert.equal(ref.current === LAST_PASS, true, 'a same-box report forgot the last pass');
    report(804, 402);
    assert.equal(ref.current, null, 'a proportional resize kept the last pass, so Live would survive it');
    assert.equal(renders(), 3, 'each report re-renders');
  });

  it('observes the device-pixel box, falling back to the CSS box where unsupported', () => {
    assert.deepEqual(setup().observer.boxes, ['device-pixel-content-box']);
    rejectDevicePixelBox = true;
    const debug = mock.method(console, 'debug', () => {});
    try {
      const { observer, ref, report } = setup();
      assert.deepEqual(observer.boxes, ['content-box']);
      report(800, 400);
      ref.current = LAST_PASS;
      report(400, 200);
      assert.equal(ref.current, null, 'the CSS-box fallback lost the resize watch');
    } finally { debug.mock.restore(); }
  });
});
