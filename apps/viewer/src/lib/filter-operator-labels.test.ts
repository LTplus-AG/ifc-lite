/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { en } from '../i18n/en';
import {
  BULK_OPERATOR_LABEL_KEYS,
  FILTER_OPERATOR_LABEL_KEYS,
  LIST_OPERATOR_LABEL_KEYS,
} from './filter-operator-labels';

describe('#5892 shared filter operator labels', () => {
  it('resolves every editor operator to a nonempty English label', () => {
    for (const labels of [
      FILTER_OPERATOR_LABEL_KEYS,
      LIST_OPERATOR_LABEL_KEYS,
      BULK_OPERATOR_LABEL_KEYS,
    ]) {
      for (const [operator, key] of Object.entries(labels)) {
        const label = en[key];
        assert.ok(typeof label === 'string' && label.trim().length > 0,
          `${operator} uses a missing or empty ${key} translation`);
      }
    }
  });

  it('shows the same not-equal label in Search, Lists, and Bulk', () => {
    const keys = [
      FILTER_OPERATOR_LABEL_KEYS.ne,
      LIST_OPERATOR_LABEL_KEYS.notEquals,
      BULK_OPERATOR_LABEL_KEYS['!='],
    ];
    assert.deepEqual(keys.map((key) => en[key]), Array(3).fill(en[FILTER_OPERATOR_LABEL_KEYS.ne]));
  });
});
