/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { formatLocaleDate, formatLocaleList, formatLocaleNumber } from './intlFormat.js';

test('formats schedule numbers and lists with the active locale', () => {
  assert.equal(formatLocaleNumber('de', 3.5, { minimumFractionDigits: 1, maximumFractionDigits: 1 }), '3,5');
  assert.equal(formatLocaleList('de', ['A', 'B', 'C']), 'A, B und C');
  assert.equal(
    formatLocaleDate('de', new Date(2026, 8, 19, 12), { year: 'numeric', month: 'short', day: 'numeric' }),
    '19. Sept. 2026',
  );
});

test('falls back to English for an invalid locale identifier', () => {
  assert.throws(() => Intl.getCanonicalLocales('replaceable'), RangeError);
  assert.equal(formatLocaleNumber('replaceable', 3.5, { minimumFractionDigits: 1 }), '3.5');
  assert.equal(formatLocaleList('replaceable', ['A', 'B']), 'A and B');
  assert.equal(
    formatLocaleDate('replaceable', new Date(Date.UTC(2026, 8, 19)), { year: 'numeric', timeZone: 'UTC' }),
    '2026',
  );
});
