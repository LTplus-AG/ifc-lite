/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The BCF server-sync toast pluralizes the loaded-topic count and the
 * skipped-item count independently (review on PR #5055): a naive single
 * template produced "Loaded 1 topics" whenever exactly one topic loaded,
 * regardless of the skipped count. `bcf.serverDialog.syncSuccess` and
 * `bcf.serverDialog.syncWarnings` are `PluralTranslation`s keyed on
 * `{count}`, and `syncWarnings` interpolates an already-resolved
 * `bcf.serverDialog.itemsSkipped` plural message for the second count
 * (the nested-`t()` pattern `PropertyEditor.tsx` also uses), rather than
 * assembling English word forms by hand.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from '@/i18n/registry.js';

describe('BCF server-sync toast pluralization (#5055 review)', () => {
  it('pluralizes the loaded-topic count on its own', () => {
    assert.equal(
      resolve('bcf.serverDialog.syncSuccess', { count: 1 }),
      'Loaded 1 topic from the BCF server',
    );
    assert.equal(
      resolve('bcf.serverDialog.syncSuccess', { count: 2 }),
      'Loaded 2 topics from the BCF server',
    );
  });

  it('pluralizes the skipped-item count on its own', () => {
    assert.equal(resolve('bcf.serverDialog.itemsSkipped', { count: 1 }), '1 item skipped');
    assert.equal(resolve('bcf.serverDialog.itemsSkipped', { count: 3 }), '3 items skipped');
  });

  it('pluralizes the loaded-topic and skipped-item counts independently in one message', () => {
    const oneTopicManySkipped = resolve('bcf.serverDialog.syncWarnings', {
      count: 1,
      itemsSkipped: resolve('bcf.serverDialog.itemsSkipped', { count: 3 }),
    });
    assert.equal(oneTopicManySkipped, 'Loaded 1 topic (3 items skipped — see console)');

    const manyTopicsOneSkipped = resolve('bcf.serverDialog.syncWarnings', {
      count: 2,
      itemsSkipped: resolve('bcf.serverDialog.itemsSkipped', { count: 1 }),
    });
    assert.equal(manyTopicsOneSkipped, 'Loaded 2 topics (1 item skipped — see console)');
  });
});
