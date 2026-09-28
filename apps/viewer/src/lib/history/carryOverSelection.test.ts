/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { fixtureModel } from '@/test/store-fixture.js';
import { captureSelection, resolveCarriedSelection } from './carryOverSelection.js';

const OLD = fixtureModel('old', {
  entities: [
    { expressId: 10, type: 'IfcWall', name: 'Wall A', globalId: '1AAAAAAAAAAAAAAAAAAAAA' },
    { expressId: 11, type: 'IfcWall', name: 'Wall B', globalId: '1BBBBBBBBBBBBBBBBBBBBB' },
  ],
});

/** Same building, re-exported: the express ids moved, the GlobalIds did not. */
const NEW = fixtureModel('new', {
  entities: [
    { expressId: 99, type: 'IfcSlab', name: 'Slab', globalId: '1CCCCCCCCCCCCCCCCCCCCC' },
    { expressId: 100, type: 'IfcWall', name: 'Wall A', globalId: '1AAAAAAAAAAAAAAAAAAAAA' },
  ],
});

describe('carryOverSelection', () => {
  it('follows the GlobalId, not the express id', () => {
    const carried = captureSelection(OLD, 10);
    assert.deepEqual(carried, { globalId: '1AAAAAAAAAAAAAAAAAAAAA' });
    // 10 in the old file is 100 in the new one. Reusing the express id would
    // silently select a different element — worse than selecting nothing.
    assert.equal(resolveCarriedSelection(NEW, carried), 100);
  });

  it('selects nothing when the element is gone in the new version', () => {
    const carried = captureSelection(OLD, 11);
    assert.equal(resolveCarriedSelection(NEW, carried), null);
  });

  it('carries nothing when there was no selection', () => {
    assert.equal(captureSelection(OLD, null), null);
    assert.equal(resolveCarriedSelection(NEW, null), null);
  });

  it('carries nothing from a model with no parsed store', () => {
    assert.equal(captureSelection(undefined, 10), null);
    assert.equal(resolveCarriedSelection(undefined, { globalId: '1AAAAAAAAAAAAAAAAAAAAA' }), null);
  });

  it('treats an entity with no GlobalId as uncarryable', () => {
    const anonymous = fixtureModel('anon', { entities: [{ expressId: 5, type: 'IfcWall' }] });
    assert.equal(captureSelection(anonymous, 5), null);
  });
});
