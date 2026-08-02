/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { screenToWorldRadius } from './snap-geometry-utils.js';

// `fov` is RADIANS (Camera.getFOV()). worldHeight = 2·dist·tan(fov/2);
// result = (screenRadius/screenHeight)·worldHeight.
test('screenToWorldRadius treats fov as radians', () => {
  // fov = π/2 → tan(π/4) = 1 → worldHeight = 2·1·1 = 2 → (100/200)·2 = 1.
  const r = screenToWorldRadius(100, 1, Math.PI / 2, 200);
  assert.ok(Math.abs(r - 1) < 1e-9, `expected 1, got ${r}`);
});

test('screenToWorldRadius does NOT re-apply a degrees→radians conversion', () => {
  // A real camera fov (~45° = π/4 rad) at 1 m must give a usable radius, not the
  // ~57×-too-small value the old `fov*π/180` produced (issue: bolts wouldn't snap).
  const fixed = screenToWorldRadius(20, 1, Math.PI / 4, 800);
  const buggy = (20 / 800) * 2 * 1 * Math.tan(((Math.PI / 4) * Math.PI) / 180 / 2);
  assert.ok(fixed > buggy * 40, `fixed (${fixed}) should dwarf the old buggy value (${buggy})`);
  // Sanity: ~1 cm-scale radius for 20 px at 1 m, not sub-millimetre.
  assert.ok(fixed > 0.005 && fixed < 0.05, `expected a usable radius, got ${fixed}`);
});
