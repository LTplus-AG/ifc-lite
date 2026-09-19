/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatLocaleCount } from './formatLocaleCount.js';

describe('formatLocaleCount (#4918)', () => {
  it('uses the active locale grouping rules', () => {
    assert.equal(formatLocaleCount(1234, 'en-US'), '1,234');
    assert.equal(formatLocaleCount(1234, 'de-DE'), '1.234');
  });

  it('falls back for deliberately invalid pseudo-locales used by i18n tests', () => {
    assert.equal(formatLocaleCount(1234, 'lists-pseudo'), '1,234');
  });
});
