/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { DoorSymbolGenerator } from './door-symbol.js';
import type { DoorSwingParameters } from '../types.js';

describe('DoorSymbolGenerator.generateSymbol (single swing)', () => {
  const generator = new DoorSymbolGenerator();
  const center = { x: 10, y: 0 };
  const width = 2;
  const wallDir = { x: 1, y: 0 };
  const swingDir = { x: 0, y: 1 };

  it('places the hinge on the -wallDir side of center for a left-hinged door', () => {
    const result = generator.generateSymbol(center, width, 'SINGLE_SWING_LEFT', wallDir, swingDir);
    const params = result.symbol.parameters as DoorSwingParameters;
    // hingeOffset = -halfWidth along wallDir => hinge x < center.x
    expect(params.hingePoint.x).toBeLessThan(center.x);
  });

  it('places the hinge on the +wallDir side of center for a right-hinged door', () => {
    const result = generator.generateSymbol(center, width, 'SINGLE_SWING_RIGHT', wallDir, swingDir);
    const params = result.symbol.parameters as DoorSwingParameters;
    expect(params.hingePoint.x).toBeGreaterThan(center.x);
  });
});
