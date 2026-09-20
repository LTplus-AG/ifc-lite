/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCapturedRefGlobalIds } from './bcfIdLookup.js';

describe('BCF captured component identity (#4921)', () => {
  it('binds a colliding renderer id to every model-qualified IFC GlobalId', () => {
    const guids = resolveCapturedRefGlobalIds(
      7,
      ['ordinary', 'room'],
      (modelId, globalId) => ({ modelId, expressId: globalId }),
      ref => `${ref.modelId}-GUID-${ref.expressId}`,
    );

    assert.deepEqual(guids, ['ordinary-GUID-7', 'room-GUID-7']);
  });

  it('keeps an exact EntityRef scoped to its named model', () => {
    const guids = resolveCapturedRefGlobalIds(
      { modelId: 'room', expressId: 7 },
      ['ordinary', 'room'],
      () => { throw new Error('an exact ref must not be range-resolved'); },
      ref => `${ref.modelId}-GUID-${ref.expressId}`,
    );

    assert.deepEqual(guids, ['room-GUID-7']);
  });
});
