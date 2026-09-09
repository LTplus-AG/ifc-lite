/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, click, type, cleanup } from '@/test/render.js';
import { AppearanceCalibrationFields } from './AppearanceCalibrationFields.js';
import type { PdfCalibration } from '@/lib/appearance/pdf/calibration.js';
import type { PdfRasterRecipe } from '@/lib/appearance/pdf/types.js';
afterEach(cleanup);
const recipe: PdfRasterRecipe = {
  page: { pageNumber: 1, viewBox: [10, 20, 210, 320], userUnit: 2, intrinsicRotation: 90,
    widthPoints: 600, heightPoints: 400, pdfToPage: [0, 2, 2, 0, -40, -20] },
  rotation: 0, cropPoints: [40, 40, 200, 100], requestedDpi: 72, effectiveDpi: 72,
  pixelWidth: 200, pixelHeight: 100, paperSizeMetres: [0.07, 0.035],
  pixelToPdf: [0, 0.5, 0.5, 0, 30, 40],
};
function mount() {
  const changes: PdfCalibration[] = [], invalid: boolean[] = [];
  const ui = render(<AppearanceCalibrationFields recipe={recipe} thumbnailUrl="blob:page" disabled={false}
    onChange={value => changes.push(value)} onInvalid={(_name, value) => invalid.push(value)} />);
  const page = ui.querySelector('button[aria-label="Choose calibration landmarks on page"]');
  const distance = ui.querySelector('input');
  assert.ok(page instanceof HTMLButtonElement);
  assert.ok(distance instanceof HTMLInputElement);
  page.getBoundingClientRect = () => new DOMRect(9, 19, 402, 202);
  const image = page.querySelector('img');
  assert.ok(image);
  image.getBoundingClientRect = () => new DOMRect(10, 20, 400, 200);
  return { ui, page, distance, changes, invalid };
}
function point(page: HTMLButtonElement, x: number, y: number) {
  act(() => page.dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 1, clientX: x, clientY: y })));
}

test('calibration uses the rendered page extent and native PDF frame, and blocks partial/invalid spans (#4260)', () => {
  const { page, distance, changes, invalid } = mount();
  assert.equal(invalid.at(-1), true);
  type(distance, '5');
  point(page, 10, 20);
  assert.equal(changes.length, 0);
  point(page, 110, 120);
  assert.deepEqual(changes, [{ sourcePoints: [[30, 40], [55, 65]], distanceMetres: 5 }]);
  assert.equal(invalid.at(-1), false);
  type(distance, '');
  assert.equal(invalid.at(-1), true);
  assert.equal(changes.length, 1, 'clearing the distance cannot publish zero metres');
  type(distance, '12.5');
  assert.equal(changes.at(-1)?.distanceMetres, 12.5);
});

test('keyboard users can place two distinct landmarks and repeated points remain invalid (#4260)', () => {
  const { page, distance, changes, invalid } = mount();
  type(distance, '2');
  click(page);
  click(page);
  assert.equal(invalid.at(-1), true);
  assert.equal(changes.length, 0);
  act(() => page.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight', shiftKey: true })));
  click(page);
  assert.equal(invalid.at(-1), false);
  assert.deepEqual(changes.at(-1), { sourcePoints: [[55, 100], [55, 90]], distanceMetres: 2 });
});
