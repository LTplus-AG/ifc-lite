/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** MCP undo of a property delete restores the row with its types (#10810). */

import { describe, expect, it } from 'vitest';
import { PropertyValueType } from '@ifc-lite/data';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { undoPendingMutations } from './mutation-undo.js';

describe('undoPendingMutations of a property delete (#10810)', () => {
  it('restores the value type and measure dataType the delete recorded', () => {
    const view = new MutablePropertyView(null, 'm');
    view.setProperty(1, 'Pset_Test', 'Width', 0.2, PropertyValueType.Real, undefined, true, 'IFCLENGTHMEASURE');
    view.deleteProperty(1, 'Pset_Test', 'Width');
    expect(undoPendingMutations(view, 1)).toBe(1);
    const row = view.getForEntity(1).find(set => set.name === 'Pset_Test')?.properties.find(p => p.name === 'Width');
    expect([row?.value, row?.type, row?.dataType]).toEqual([0.2, PropertyValueType.Real, 'IFCLENGTHMEASURE']);
  });
});
