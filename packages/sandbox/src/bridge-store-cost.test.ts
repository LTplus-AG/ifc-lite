/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from 'vitest';
import type { BimContext } from '@ifc-lite/sdk';
import { buildStoreCostMethods } from './bridge-store-cost.js';

describe('bim.store loaded-model cost bridge (#4857)', () => {
  it('registers and dispatches all nine cost authoring methods', () => {
    const methods = buildStoreCostMethods();
    expect(methods.map(method => method.name)).toEqual([
      'addCostSchedule', 'addCostItem', 'addCostValue', 'addCostQuantity',
      'nestCostItems', 'assignCostItemsToSchedule', 'assignToCostItem',
      'setCostItemValues', 'removeCostEntity',
    ]);

    const addCostItem = vi.fn(() => ({ modelId: 'm', expressId: 42 }));
    const sdk = { store: { addCostItem } } as unknown as BimContext;
    const method = methods.find(candidate => candidate.name === 'addCostItem')!;
    expect(method.call(sdk, ['m', { Name: 'Concrete' }], { sandboxSessionId: 'test' })).toEqual({ modelId: 'm', expressId: 42 });
    expect(addCostItem).toHaveBeenCalledWith('m', { Name: 'Concrete' });
  });
});
