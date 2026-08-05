/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Federation ID-space arithmetic — `local expressId ↔ renderer globalId`.
 *
 * This module had no tests at all: a mutation sweep confirmed that deleting
 * the offset entirely (`return expressId + (model.idOffset ?? 0)` →
 * `return expressId`) left the WHOLE apps/viewer suite (2750 tests) green.
 * On screen that mutation means clicking a wall in the second federated
 * model highlights / selects an unrelated element from the first one.
 *
 * The boundary cases below matter because the offset window is CLOSED at
 * both ends: `[idOffset, idOffset + maxExpressId]`. An off-by-one at either
 * end silently reassigns a real element to the neighbouring model.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FederatedModel } from './types.js';
import {
  toGlobalIdFromModels,
  fromGlobalIdFromModels,
  toGlobalIdForRef,
  type ForwardModelMapLike,
} from './globalId.js';

type ReverseEntry = Pick<FederatedModel, 'idOffset' | 'maxExpressId'>;

/** Two models: A owns global [0, 500], B owns global [1000, 1300]. */
function twoModels(): Map<string, ReverseEntry> {
  return new Map<string, ReverseEntry>([
    ['model-a', { idOffset: 0, maxExpressId: 500 }],
    ['model-b', { idOffset: 1000, maxExpressId: 300 }],
  ]);
}

describe('toGlobalIdFromModels', () => {
  it('adds the model offset for a federated model', () => {
    const models: ForwardModelMapLike = new Map([['model-b', { idOffset: 1000 }]]);
    assert.equal(toGlobalIdFromModels(models, 'model-b', 42), 1042);
  });

  it('is the identity for a model whose offset is 0', () => {
    const models: ForwardModelMapLike = new Map([['model-a', { idOffset: 0 }]]);
    assert.equal(toGlobalIdFromModels(models, 'model-a', 42), 42);
  });

  it('treats an offset-carrying model differently from the legacy sentinels', () => {
    // Both directions pinned: the sentinel path must IGNORE an offset that
    // the same map would otherwise apply. Without this pairing a mutation
    // that drops either branch keeps one of the two assertions true.
    const models: ForwardModelMapLike = new Map([
      ['legacy', { idOffset: 1000 }],
      ['default', { idOffset: 1000 }],
      ['__legacy__', { idOffset: 1000 }],
      ['real', { idOffset: 1000 }],
    ]);
    assert.equal(toGlobalIdFromModels(models, 'legacy', 7), 7);
    assert.equal(toGlobalIdFromModels(models, 'default', 7), 7);
    assert.equal(toGlobalIdFromModels(models, '__legacy__', 7), 7);
    assert.equal(toGlobalIdFromModels(models, 'real', 7), 1007);
  });

  it('falls back to the raw expressId for an unknown model id', () => {
    const models: ForwardModelMapLike = new Map([['model-b', { idOffset: 1000 }]]);
    assert.equal(toGlobalIdFromModels(models, 'not-loaded', 42), 42);
  });

  it('treats a model entry with no idOffset as offset 0', () => {
    const models: ForwardModelMapLike = new Map([['model-x', {}]]);
    assert.equal(toGlobalIdFromModels(models, 'model-x', 42), 42);
  });

  it('toGlobalIdForRef forwards modelId + expressId to the same arithmetic', () => {
    const models: ForwardModelMapLike = new Map([['model-b', { idOffset: 1000 }]]);
    assert.equal(toGlobalIdForRef(models, { modelId: 'model-b', expressId: 42 }), 1042);
  });
});

describe('fromGlobalIdFromModels', () => {
  it('returns the legacy sentinel when no models are registered', () => {
    assert.deepEqual(
      fromGlobalIdFromModels(new Map(), 42),
      { modelId: 'legacy', expressId: 42 },
    );
  });

  it('routes an id to the model whose offset window contains it', () => {
    const models = twoModels();
    assert.deepEqual(fromGlobalIdFromModels(models, 42), { modelId: 'model-a', expressId: 42 });
    assert.deepEqual(fromGlobalIdFromModels(models, 1042), { modelId: 'model-b', expressId: 42 });
  });

  it('includes the LOWER boundary: localId exactly 0 belongs to the model', () => {
    const models = twoModels();
    assert.deepEqual(fromGlobalIdFromModels(models, 0), { modelId: 'model-a', expressId: 0 });
    assert.deepEqual(fromGlobalIdFromModels(models, 1000), { modelId: 'model-b', expressId: 0 });
  });

  it('includes the UPPER boundary: localId exactly maxExpressId belongs to the model', () => {
    const models = twoModels();
    assert.deepEqual(fromGlobalIdFromModels(models, 500), { modelId: 'model-a', expressId: 500 });
    assert.deepEqual(fromGlobalIdFromModels(models, 1300), { modelId: 'model-b', expressId: 300 });
  });

  it('excludes an id one past the upper boundary (gap between models)', () => {
    const models = twoModels();
    // 501 is above model-a's max and below model-b's offset — owned by neither.
    assert.equal(fromGlobalIdFromModels(models, 501), undefined);
    // Past model-b's window entirely, with >1 model so no single-model rescue.
    assert.equal(fromGlobalIdFromModels(models, 1301), undefined);
  });

  it('rescues an out-of-range id when exactly one model is loaded', () => {
    // Overlay-allocated ids land above the parse-time maxExpressId; with a
    // single model the offset-corrected id is still the right answer.
    const single = new Map<string, ReverseEntry>([['only', { idOffset: 100, maxExpressId: 50 }]]);
    assert.deepEqual(fromGlobalIdFromModels(single, 999), { modelId: 'only', expressId: 899 });
  });

  it('round-trips every model through toGlobalId → fromGlobalId', () => {
    const reverse = twoModels();
    const forward: ForwardModelMapLike = new Map([
      ['model-a', { idOffset: 0 }],
      ['model-b', { idOffset: 1000 }],
    ]);
    for (const [modelId, entry] of reverse) {
      for (const expressId of [0, 1, entry.maxExpressId]) {
        const global = toGlobalIdFromModels(forward, modelId, expressId);
        assert.deepEqual(
          fromGlobalIdFromModels(reverse, global),
          { modelId, expressId },
          `${modelId}#${expressId} must round-trip`,
        );
      }
    }
  });
});
