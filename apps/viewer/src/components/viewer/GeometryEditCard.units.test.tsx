/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6233: the Geometry card showed `X = -5618.216808585` (raw millimetres)
 * next to "±0.5 m" nudge steps. It must read metres at millimetre precision
 * and nudge by the labelled metric distance, in a metre and a millimetre
 * model alike.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { cleanup, click, render } from '@/test/render.js';
import { WALL, WALL_MODEL, WALL_UNITS, seedRectangleWall } from '@/test/rectangle-wall-fixture';
import { GeometryEditCard } from './GeometryEditCard.js';

const EXACT_X = -5.618216808585;

function axisValues(): string[] {
  return [...document.body.querySelectorAll<HTMLInputElement>('input[type="number"]')].map((input) => input.value);
}

function button(name: string): HTMLElement {
  const found = [...document.body.querySelectorAll<HTMLElement>('button')]
    .find((b) => b.getAttribute('aria-label') === name || b.textContent?.trim() === name);
  assert.ok(found, `no "${name}" button`);
  return found;
}

const positionX = () => useViewerStore.getState().readEntityPosition(WALL_MODEL, WALL)![0];

for (const { name, unit, scale } of WALL_UNITS) {
  describe(`Geometry card in a ${name} model (#6233)`, () => {
    beforeEach(async () => {
      await seedRectangleWall(unit, scale);
      assert.ok(useViewerStore.getState().setEntityPosition(WALL_MODEL, WALL, [EXACT_X, 1, 0]).ok);
    });
    afterEach(() => cleanup());

    it('shows metres rounded to the millimetre', () => {
      render(<GeometryEditCard modelId={WALL_MODEL} entityId={WALL} />);
      assert.deepEqual(axisValues(), ['-5.618', '1', '0']);
    });

    it('a +X nudge moves by the selected 0.5 m', () => {
      render(<GeometryEditCard modelId={WALL_MODEL} entityId={WALL} />);
      click(button('Increase X'));
      assert.ok(Math.abs(positionX() - (EXACT_X + 0.5)) < 1e-9, `x = ${positionX()}`);
      assert.deepEqual(axisValues(), ['-5.118', '1', '0']);
    });

    it('Apply XYZ keeps the exact coordinate of an axis the user did not edit', () => {
      render(<GeometryEditCard modelId={WALL_MODEL} entityId={WALL} />);
      click(button('Apply XYZ'));
      assert.ok(Math.abs(positionX() - EXACT_X) < 1e-9, `x snapped to ${positionX()}`);
    });
  });
}
