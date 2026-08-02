/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { presetViewRotation } from './preset-view-orientation.js';

describe('presetViewRotation (#1532)', () => {
  const BR = Math.PI; // ~180deg IfcSite placement rotation (the reported case)

  it('drops building rotation for TOP/BOTTOM when the world-context basemap is active (north-up)', () => {
    assert.strictEqual(presetViewRotation('top', BR, true), 0);
    assert.strictEqual(presetViewRotation('bottom', BR, true), 0);
  });

  it('keeps building rotation for TOP/BOTTOM when the basemap is off (plan stays building-aligned)', () => {
    assert.strictEqual(presetViewRotation('top', BR, false), BR);
    assert.strictEqual(presetViewRotation('bottom', BR, false), BR);
  });

  it('always keeps building rotation for side views (they face the building front)', () => {
    for (const v of ['front', 'back', 'left', 'right'] as const) {
      assert.strictEqual(presetViewRotation(v, BR, true), BR);
      assert.strictEqual(presetViewRotation(v, BR, false), BR);
    }
  });

  it('passes undefined building rotation through unchanged, but still forces 0 for world-context top/bottom', () => {
    assert.strictEqual(presetViewRotation('front', undefined, false), undefined);
    assert.strictEqual(presetViewRotation('top', undefined, false), undefined);
    assert.strictEqual(presetViewRotation('top', undefined, true), 0);
    assert.strictEqual(presetViewRotation('bottom', undefined, true), 0);
  });
});
