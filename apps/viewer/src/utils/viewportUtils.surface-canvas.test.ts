/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The viewport clear colour is the shell's canvas surface (#8802 R1): a
 * neutral tone one step from the panel surface toward mid-grey, so the model
 * area reads as the workspace and white walls keep an edge against it. The
 * same hex is the `--surface-canvas` token in `index.css`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getThemeClearColor, VIEWPORT_CANVAS_HEX } from './viewportUtils.js';

describe('viewport canvas colour (#8802 R1)', () => {
  it('spells each theme canvas hex as an opaque 0..1 sRGB clear colour', () => {
    for (const theme of ['light', 'dark'] as const) {
      const hex = VIEWPORT_CANVAS_HEX[theme];
      const expected = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
      assert.deepEqual(getThemeClearColor(theme).slice(0, 3), expected, theme);
      assert.equal(getThemeClearColor(theme)[3], 1, theme);
    }
  });

  it('the canvas is neutral, one step from the panel toward mid-grey', () => {
    for (const theme of ['light', 'dark'] as const) {
      const [r, g, b] = getThemeClearColor(theme);
      assert.ok(Math.max(r, g, b) - Math.min(r, g, b) < 0.03, `${theme} canvas has a hue cast`);
    }
    // Light panels are white; dark panels are #18191b (`--surface-panel`).
    assert.ok(getThemeClearColor('light')[0] < 0.95, 'light canvas is visibly darker than the white panel');
    assert.ok(getThemeClearColor('dark')[0] > 0x18 / 255, 'dark canvas is lighter than the panel');
  });

  it('colorful keeps a transparent clear so its CSS backdrop shows through', () => {
    assert.deepEqual(getThemeClearColor('colorful'), [0, 0, 0, 0]);
  });
});
