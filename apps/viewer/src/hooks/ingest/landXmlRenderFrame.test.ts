/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  boundsFitRenderFrame,
} from './landXmlRenderFrame.js';

describe('LandXML render frame acceptance (#5049)', () => {
  it('accepts a centimetre-scale component at a 5,000-km survey origin', () => {
    assert.equal(boundsFitRenderFrame({
      min: { x: 5_000_000.015625, y: 20, z: -4 },
      max: { x: 5_000_000.025625, y: 20.01, z: -3.99 },
    }, { x: 5_000_000.015625, y: 20, z: -4 }), true);
  });

  it('refuses a compact island outside the shared render-frame envelope (#5010)', () => {
    assert.equal(boundsFitRenderFrame({
      min: { x: 5_000_000.015625, y: 20, z: -4 },
      max: { x: 5_000_000.025625, y: 20.01, z: -3.99 },
    }, { x: 0, y: 0, z: 0 }), false);
  });

  it('accepts a 1,500-km span centred on the shared frame (#5049)', () => {
    assert.equal(boundsFitRenderFrame({
      min: { x: -750_000, y: 0, z: 0 },
      max: { x: 750_000, y: 1, z: 1 },
    }, { x: 0, y: 0, z: 0 }), true);
  });
});
