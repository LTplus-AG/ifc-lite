/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FederationRegistry } from '../../../../packages/renderer/src/federation-registry.js';
import { toPublishedGlobalId } from './federation-overlay-publication.js';

describe('mutation overlay federation publication', () => {
  it('publishes contiguous authored records before resolving a new entity in a two-model session (#5050)', () => {
    const registry = new FederationRegistry();
    registry.registerModel('editable', 100);
    const otherOffset = registry.registerModel('other', 50);
    const models = new Map([
      ['editable', { maxExpressId: 100 }],
      ['other', { maxExpressId: 50 }],
    ]);
    const authored = new Set([101, 102, 103]);
    const views = new Map([
      ['editable', { getNewEntity: (id: number) => authored.has(id) ? { expressId: id } : null }],
    ]);

    assert.equal(toPublishedGlobalId(registry, models, views, 'editable', 103), 103);
    assert.deepEqual(registry.fromGlobalId(102), { modelId: 'editable', expressId: 102 });
    assert.deepEqual(registry.fromGlobalId(otherOffset + 1), { modelId: 'other', expressId: 1 });

    // Published ownership is permanent. Mutation-view liveness is resolved
    // separately so undo/history/remote references cannot be remapped.
    authored.delete(102);
    assert.equal(toPublishedGlobalId(registry, models, views, 'editable', 102), 102);
    assert.deepEqual(registry.fromGlobalId(102), { modelId: 'editable', expressId: 102 });
  });

  it('does not publish a reserved hole without an owned overlay record (#5050)', () => {
    const registry = new FederationRegistry();
    registry.registerModel('editable', 100);
    const models = new Map([['editable', { maxExpressId: 100 }]]);
    const views = new Map([
      ['editable', { getNewEntity: (id: number) => id === 102 ? { expressId: id } : null }],
    ]);

    assert.throws(
      () => toPublishedGlobalId(registry, models, views, 'editable', 102),
      /not published/,
    );
    assert.equal(registry.fromGlobalId(101), null);
  });
});
