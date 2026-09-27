/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Measurement labels are scene-kernel `WorldLabel`s (#5502, charter #5478
 * §3.1): ink when the measurement is finished, accent while it is live, and
 * anchored to the WORLD midpoint through the projector rather than to a
 * screen coordinate the store happened to carry. Rendered on the kernel's
 * stub harness (`renderScene`): a stub camera that maps world x/y straight
 * to screen px, so the projected transform is checkable to the pixel.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup } from '@/test/render.js';
import { renderScene } from '../../viewport-ui/scene/test/scene-test-support.js';
import { MeasurementOverlays, type MeasurementOverlaysProps } from './MeasurementVisuals.js';

afterEach(cleanup);

const BASE: MeasurementOverlaysProps = {
  measurements: [],
  pending: null,
  activeMeasurement: null,
  snapTarget: null,
  snapVisualization: null,
};

const pt = (x: number, y: number, z: number) => ({ x, y, z, screenX: -1, screenY: -1 });

function labels(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-scene-primitive="world-label"]')];
}
const card = (label: HTMLElement) => label.firstElementChild as HTMLElement;

describe('measurement labels on the scene kernel (#5502)', () => {
  it('a finished measurement gets an ink label at its world midpoint, with the breakdown', () => {
    const scene = renderScene(
      <MeasurementOverlays {...BASE} measurements={[{ id: 'm1', start: pt(0, 0, 0), end: pt(40, 20, 0), distance: 44.72 }]} />,
    );
    scene.source.dirty = true;
    scene.flush();
    const [label] = labels();
    assert.ok(label, 'no world label rendered for a finished measurement');
    // Midpoint of (0,0,0)-(40,20,0) is (20,10,0); the stub camera projects
    // world x/y straight to screen px. Screen coords on the points are
    // deliberately -1 so a label still reading them would land elsewhere.
    assert.equal(label.style.transform, 'translate(20px, 10px)');
    assert.equal(label.style.display, '');
    assert.match(card(label).className, /border-border/);
    assert.doesNotMatch(card(label).className, /border-overlay-accent/);
    assert.match(card(label).textContent ?? '', /44\.720 m/);
    assert.match(card(label).textContent ?? '', /dX 40\.000 m/);
    assert.equal(scene.container.querySelector('[class*="bg-overlay-ink"]'), null, 'no inverted ink bar remains');
  });

  it('the live drag and the live polyline get accent labels; finished ones stay ink', () => {
    const scene = renderScene(
      <MeasurementOverlays
        {...BASE}
        measurements={[{ id: 'm1', start: pt(0, 0, 0), end: pt(2, 0, 0), distance: 2 }]}
        activeMeasurement={{ start: pt(0, 0, 0), current: pt(6, 8, 0), distance: 10 }}
        activePolyline={{ points: [pt(1, 1, 0), pt(4, 5, 0)] }}
        polylineMeasurements={[{ id: 'pl1', points: [pt(0, 0, 0), pt(3, 0, 0), pt(3, 3, 0)], closed: true, length: 9 }]}
      />,
    );
    scene.source.dirty = true;
    scene.flush();
    const all = labels();
    assert.equal(all.length, 4);
    const accent = all.filter((l) => /border-overlay-accent/.test(card(l).className));
    const ink = all.filter((l) => /border-border/.test(card(l).className));
    assert.equal(accent.length, 2, 'exactly the two live labels are accent');
    assert.equal(ink.length, 2, 'exactly the two finished labels are ink');
    assert.ok(accent.some((l) => /10\.000 m/.test(card(l).textContent ?? '')), 'live drag distance');
    assert.ok(accent.some((l) => /Length so far - 2 pts/.test(card(l).textContent ?? '')), 'live polyline running length');
    assert.ok(ink.some((l) => /Perimeter \(closed\)/.test(card(l).textContent ?? '')), 'finished polyline basis');
    // The finished polyline's label sits at the vertex centroid (2, 1).
    const perimeter = ink.find((l) => /Perimeter/.test(card(l).textContent ?? ''))!;
    assert.equal(perimeter.style.transform, 'translate(2px, 1px)');
  });

  it('hides a label whose anchor is behind the camera instead of parking it at a stale pixel', () => {
    const scene = renderScene(
      <MeasurementOverlays {...BASE} measurements={[{ id: 'm1', start: pt(0, 0, 0), end: pt(4, 0, 0), distance: 4 }]} />,
    );
    scene.source.dirty = true;
    scene.flush();
    assert.equal(labels()[0].style.display, '');
    scene.source.camera.behind = true;
    scene.source.dirty = true;
    scene.flush();
    assert.equal(labels()[0].style.display, 'none');
  });
});
