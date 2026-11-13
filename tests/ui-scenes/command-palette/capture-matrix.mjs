#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Reuse the repository's real-model capture protocol with palette-specific scenes.
import { SCENES } from '../scenes.mjs';
const palette = SCENES.find(scene => scene.id === 'command-palette');
if (!palette) throw new Error('Missing canonical command-palette scene');
palette.viewport = { width: 1440, height: 900 };
for (const [id, query, width, height, loaded] of [
  ['palette-browse', '', 1440, 900, true],
  ['palette-annot', 'annot', 1440, 900, true],
  ['palette-narrow', 'annot', 390, 844, true],
  ['palette-empty', 'zzzz-no-palette-command-8946', 390, 844, false],
  ['palette-short', 'zzzz-no-palette-command-8946', 800, 400, false],
]) {
  SCENES.push({ ...palette, id, title: `${id}: ${query || 'browse'}`,
    model: loaded ? palette.model : null, viewport: { width, height },
    async run({ page }) {
      await page.keyboard.press('Control+k');
      if (query) await page.keyboard.type(query);
    },
  });
}
await import('../capture.mjs');
