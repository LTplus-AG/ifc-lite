/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FederationRegistry } from '../../../../packages/renderer/src/federation-registry.js';
import { preparePreparedOverlayPublication, previewPreparedOverlayGlobalId, publishPreparedOverlayRange, toPreparedOverlayGlobalId, toPublishedGlobalId } from './federation-overlay-publication.js';

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

  it('previews a detached contiguous creation batch without publishing it (#4308)', () => {
    const registry = new FederationRegistry();
    registry.registerModel('editable', 100);
    const otherOffset = registry.registerModel('other', 50);
    const models = new Map([
      ['editable', { maxExpressId: 100 }],
      ['other', { maxExpressId: 50 }],
    ]);
    const created = [{ expressId: 101 }, { expressId: 102 }, { expressId: 103 }];

    assert.equal(previewPreparedOverlayGlobalId(registry, models, 'editable', created, 103), 103);
    assert.equal(registry.fromGlobalId(103), null, 'previewed IDs remain unpickable before their transaction commits');
    assert.throws(() => registry.toGlobalId('editable', 103), /not published/);
    assert.deepEqual(registry.fromGlobalId(otherOffset + 1), { modelId: 'other', expressId: 1 });
    const views = new Map([['editable', { getNewEntity: (id: number) => created.some(entity => entity.expressId === id) ? { expressId: id } : null }]]);
    publishPreparedOverlayRange(registry, models, views, 'editable', created);
    assert.equal(registry.toGlobalId('editable', 101), 101);
    assert.equal(registry.toGlobalId('editable', 103), 103);
    assert.throws(
      () => previewPreparedOverlayGlobalId(registry, models, 'editable', [{ expressId: 101 }, { expressId: 103 }], 103),
      /contiguous/,
    );
  });

  it('maps only an exact detached plan range while keeping it unpickable (#5050)', () => {
    const registry = new FederationRegistry();
    registry.registerModel('prior', 10);
    const offset = registry.registerModel('editable', 100);
    const models = new Map([['editable', { maxExpressId: 100 }]]);
    const views = new Map([['editable', { getNewEntity: () => null }]]);
    const created = [{ expressId: 101 }, { expressId: 102 }];

    assert.equal(toPreparedOverlayGlobalId(registry, { models, mutationViews: views }, 'editable', created, 102), offset + 102);
    assert.equal(registry.fromGlobalId(offset + 102), null, 'a review preview cannot become selectable before commit');
    assert.throws(
      () => toPreparedOverlayGlobalId(registry, { models, mutationViews: views }, 'editable', created, 103),
      /not published/,
      'a reserved hole outside the reviewed plan remains unresolvable',
    );
  });

  it('publishes an owned prefix before previewing a later detached plan (#5050)', () => {
    const registry = new FederationRegistry();
    registry.registerModel('editable', 100);
    const models = new Map([['editable', { maxExpressId: 100 }]]);
    const owned = new Set([101, 102]);
    const views = new Map([['editable', { getNewEntity: (id: number) => owned.has(id) ? { expressId: id } : null }]]);
    const created = [{ expressId: 103 }, { expressId: 104 }];

    assert.equal(toPreparedOverlayGlobalId(registry, { models, mutationViews: views }, 'editable', created, 102), 102,
      'an already committed product resolves through the normal publication path');
    assert.equal(toPreparedOverlayGlobalId(registry, { models, mutationViews: views }, 'editable', created, 104), 104);
    assert.equal(registry.toGlobalId('editable', 102), 102, 'the committed prefix is now published');
    assert.equal(registry.fromGlobalId(104), null, 'the detached tail is still not owned');
  });

  it('preflights a live detached range before GPU publication without granting ownership (#5050)', () => {
    const registry = new FederationRegistry();
    registry.registerModel('editable', 100);
    const models = new Map([['editable', { maxExpressId: 100 }]]);
    const created = [{ expressId: 101 }, { expressId: 102 }];
    const views = new Map([['editable', {
      getNewEntity: (id: number) => created.some(entity => entity.expressId === id) ? { expressId: id } : null,
    }]]);

    const publish = preparePreparedOverlayPublication(registry, { models, mutationViews: views }, 'editable', created);
    assert.notEqual(publish, null);
    assert.throws(() => registry.toGlobalId('editable', 101), /not published/);
    publish?.();
    assert.equal(registry.toGlobalId('editable', 102), 102);
  });

  it('leaves an unregistered single model on the canonical local-ID fallback (#5050)', () => {
    const registry = new FederationRegistry();
    const models = new Map([['primary', { maxExpressId: 100 }]]);
    const created = [{ expressId: 101 }];
    const views = new Map([['primary', { getNewEntity: () => ({ expressId: 101 }) }]]);

    assert.equal(preparePreparedOverlayPublication(registry, { models, mutationViews: views }, 'primary', created), null);
  });

  it('rejects an overlay beyond reserved federation headroom before GPU commit (#5050)', () => {
    const registry = new FederationRegistry();
    registry.registerModel('editable', 100);
    registry.publishOverlayRange('editable', 101, 1_000_100);
    const models = new Map([['editable', { maxExpressId: 100 }]]);
    const created = [{ expressId: 1_000_101 }];
    const views = new Map([['editable', { getNewEntity: () => ({ expressId: 1_000_101 }) }]]);

    assert.throws(
      () => preparePreparedOverlayPublication(registry, { models, mutationViews: views }, 'editable', created),
      /Invalid overlay preview/,
    );
    assert.throws(() => registry.toGlobalId('editable', 1_000_101), /not published/);
  });

  it('rejects a registered model whose base range has not been published (#5050)', () => {
    const registry = new FederationRegistry();
    registry.reserveModel('editable', 100);
    const models = new Map([['editable', { maxExpressId: 100 }]]);
    const created = [{ expressId: 101 }];
    const views = new Map([['editable', { getNewEntity: () => ({ expressId: 101 }) }]]);

    assert.throws(
      () => preparePreparedOverlayPublication(registry, { models, mutationViews: views }, 'editable', created),
      /published federation base range/,
    );
  });
});
