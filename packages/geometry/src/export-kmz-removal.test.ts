/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { IfcLiteBridge } from './ifc-lite-bridge.js';
import { GeometryProcessor } from './index.js';

describe('GLB-in-KMZ API removal (#4591)', () => {
  it('does not expose exportKmz on either public geometry facade', () => {
    expect(Object.prototype.hasOwnProperty.call(IfcLiteBridge.prototype, 'exportKmz')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(GeometryProcessor.prototype, 'exportKmz')).toBe(false);
  });
});
