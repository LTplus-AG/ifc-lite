/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ZERO_ROTATION, type ModelRotation } from './rotation.js';
import type { ModelPlacement } from './state.js';
import type { Translation } from './translation.js';

/**
 * Builds a `ModelPlacement` fixture for tests that only care about
 * translation and lock state (#4869).
 *
 * `ModelPlacement` gained a required `rotation` field so "no rotation" can
 * never be confused with "rotation unknown" (see `rotation.ts`). That made
 * every pre-existing `{ translation, locked }` fixture stop type-checking.
 * Routing fixtures through this helper means the next required field lands
 * here once instead of breaking every call site again.
 */
export function testPlacement(
  translation: Translation,
  overrides: { locked?: boolean; rotation?: ModelRotation } = {},
): ModelPlacement {
  return {
    translation,
    rotation: overrides.rotation ?? ZERO_ROTATION,
    locked: overrides.locked ?? false,
  };
}
