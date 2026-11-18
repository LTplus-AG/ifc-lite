/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { formatLocaleDate, formatLocaleList, formatLocaleNumber, formatLocaleValueList, parseLocaleNumber } from './intlFormat.js';

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

test('parses localized decimal separators, grouping and digits as one complete number', () => {
  assert.equal(parseLocaleNumber('de-DE', '1.234,5'), 1234.5);
  assert.equal(parseLocaleNumber('ar-EG', '١٬٢٣٤٫٥'), 1234.5);
  assert.equal(parseLocaleNumber('de-DE', '1234,5 trailing'), null);
});

test('lists a vector\'s components without a conjunction, never ambiguous with a decimal comma (#9668)', () => {
  assert.equal(formatLocaleValueList('en', ['1.5', '0', '-1']), '1.5, 0, -1');
  for (const locale of ['de', 'fr', 'it']) {
    const items = [formatLocaleNumber(locale, 1.5), '0', '-1'];
    assert.equal(formatLocaleValueList(locale, items), `${items[0]}; 0; -1`, locale);
  }
});
