/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { BUILTIN_LENSES } from './presets.js';
import { evaluateAutoColorLens } from './engine.js';
import { GHOST_COLOR } from './colors.js';
import type { LensDataProvider } from './types.js';

// #6598: equal stage values form one group; unassigned elements remain ghosted.
describe('By Stage preset', () => {
  it('groups equal integer stages and keeps other property sets separate', () => {
    const lens = BUILTIN_LENSES.find(l => l.id === 'lens-by-stage');
    expect(lens?.autoColor).toBeDefined();
    const rows = new Map([[1, 2], [2, 2], [3, 4]]);
    const provider: LensDataProvider = {
      getEntityCount: () => 4,
      forEachEntity: callback => { for (const id of [1, 2, 3, 4]) callback(id, 'model'); },
      getEntityType: () => 'IfcWall',
      getPropertySets: () => [],
      getPropertyValue: (id, pset, property) => pset === 'CESIUM' && property === 'Stage' ? rows.get(id) : undefined,
    };
    const result = evaluateAutoColorLens(lens!.autoColor!, provider);
    expect(result.colorMap.get(1)).toEqual(result.colorMap.get(2));
    expect(result.colorMap.get(1)).not.toEqual(result.colorMap.get(3));
    expect(result.colorMap.get(4)).toEqual(GHOST_COLOR);
    expect(result.legend.map(entry => [entry.name, entry.count])).toEqual([['2', 2], ['4', 1]]);
  });
});
