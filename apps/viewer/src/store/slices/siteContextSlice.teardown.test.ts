/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #10481 review: removing a site-context model (or clearing all models) must
 * not leave its category reported `done` against a model that is gone.
 */

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { viewerTeardownRegistry } from '../teardown-registry.js';
import type { SiteContextModelInfo, SiteContextSlice } from './siteContextSlice.js';

function contribution() {
  const entry = viewerTeardownRegistry.find((e) => e.slice === 'siteContextSlice');
  assert.ok(entry);
  return entry;
}

function loaded(): Pick<SiteContextSlice, 'siteContextCategories' | 'siteContextModels'> {
  const record: SiteContextModelInfo = { kind: 'terrain', attribution: [], issues: [], complete: true, origin: [0, 0, 0] };
  return {
    siteContextCategories: {
      terrain: { status: 'done', modelId: 'ctx-terrain', issues: [], attribution: [] },
      parcel: { status: 'done', modelId: 'ctx-parcel', issues: [], attribution: [] },
    },
    siteContextModels: new Map<string, SiteContextModelInfo>([['ctx-terrain', record], ['ctx-parcel', { ...record, kind: 'parcel' }]]),
  };
}

it('model-removed returns that category to idle and keeps the others', () => {
  const state = loaded();
  const patch = contribution().teardown({ kind: 'model-removed', modelId: 'ctx-terrain', isStale: () => false, nextActiveModelId: null }, state);
  assert.deepEqual(patch.siteContextCategories?.terrain, { status: 'idle', issues: [], attribution: [] });
  assert.equal(patch.siteContextCategories?.parcel?.status, 'done');
  assert.deepEqual([...(patch.siteContextModels?.keys() ?? [])], ['ctx-parcel']);
  assert.equal(state.siteContextCategories.terrain?.status, 'done', 'the input is not mutated');
});

it('removing an unrelated model changes nothing', () => {
  const patch = contribution().teardown({ kind: 'model-removed', modelId: 'some-ifc', isStale: () => false, nextActiveModelId: null }, loaded());
  assert.deepEqual(patch, {});
});

it('all-models-cleared leaves no category reported loaded', () => {
  const patch = contribution().teardown({ kind: 'all-models-cleared' }, loaded());
  assert.deepEqual(patch.siteContextCategories, {});
  assert.equal(patch.siteContextModels?.size, 0);
});
