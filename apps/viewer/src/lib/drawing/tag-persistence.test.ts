/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { validElementTags, restoreElementTags } from './tag-persistence.js';

const tag = { id: 't', modelId: 'previous-load', entityId: 10, anchor: { x: 2, y: 3 }, offset: { x: 0.2, y: 0.3 }, template: 'auto' as const };
it('#9296 saved tags reject malformed identity and non-finite coordinates', () => {
  assert.deepEqual(validElementTags(undefined), []);
  assert.deepEqual(validElementTags([tag, { ...tag, entityId: NaN }, { ...tag, anchor: { x: Infinity, y: 1 } }, { ...tag, modelId: '' }]), [tag]);
});
it('#9296 reopening a drawing rebinds its owner and preserves federated model identity', () => {
  const foreign = { ...tag, id: 'foreign', modelId: 'another-model' };
  const restored = restoreElementTags([tag, foreign], 'previous-load', 'new-load');
  assert.equal(restored[0].modelId, 'new-load');
  assert.deepEqual(restored[0].offset, tag.offset);
  assert.equal(restored[1].modelId, 'another-model');
  assert.equal(tag.modelId, 'previous-load', 'restoration must not mutate stored entries');
});
