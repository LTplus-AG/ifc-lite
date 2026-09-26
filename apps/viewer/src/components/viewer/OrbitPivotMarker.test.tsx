/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { OrbitPivotMarker } from './OrbitPivotMarker.js';
import { orbitPivotStore } from './orbitPivotStore.js';

const realRequestFrame = globalThis.requestAnimationFrame;
const realCancelFrame = globalThis.cancelAnimationFrame;

afterEach(() => {
  cleanup();
  orbitPivotStore.end();
  globalThis.requestAnimationFrame = realRequestFrame;
  globalThis.cancelAnimationFrame = realCancelFrame;
  document.body.innerHTML = '';
});

it('shows the projected orbit pivot in CSS pixels and follows the camera without React frame updates (#5891)', () => {
  let frame: FrameRequestCallback | undefined;
  let cancelled = false;
  globalThis.requestAnimationFrame = (callback) => { frame = callback; return 1; };
  globalThis.cancelAnimationFrame = () => { cancelled = true; };

  const canvas = document.createElement('canvas');
  canvas.width = 800;
  canvas.height = 600;
  canvas.getBoundingClientRect = () => ({ width: 400, height: 300 }) as DOMRect;
  document.body.appendChild(canvas);
  let projected = { x: 200, y: 150 };
  const point = { x: 1, y: 2, z: 3 };
  const camera = { projectToScreen: () => projected };
  const ui = render(<OrbitPivotMarker />);
  const marker = ui.querySelector<HTMLElement>('[data-orbit-pivot-marker]');
  assert.ok(marker);
  assert.equal(marker.getAttribute('aria-hidden'), 'true');
  assert.match(marker.className, /pointer-events-none/);
  assert.match(marker.className, /opacity-0/);

  act(() => orbitPivotStore.begin({ point, camera, canvas }));
  assert.match(marker.className, /opacity-100/);
  assert.equal(marker.style.left, '100px');
  assert.equal(marker.style.top, '75px');

  projected = { x: 400, y: 300 };
  frame?.(0);
  assert.equal(marker.style.left, '200px');
  assert.equal(marker.style.top, '150px');

  act(() => orbitPivotStore.end());
  assert.match(marker.className, /opacity-0/);
  assert.equal(cancelled, true);
});
