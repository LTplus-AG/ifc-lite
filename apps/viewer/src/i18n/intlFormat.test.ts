/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { formatLocaleList, formatLocaleNumber } from './intlFormat.js';

test('formats schedule numbers and lists with the active locale', () => {
  assert.equal(formatLocaleNumber('de', 3.5, { minimumFractionDigits: 1, maximumFractionDigits: 1 }), '3,5');
  assert.equal(formatLocaleList('de', ['A', 'B', 'C']), 'A, B und C');
});

test('falls back for synthetic test locale identifiers', () => {
  assert.doesNotThrow(() => formatLocaleNumber('schedule-pseudo', 3.5));
  assert.doesNotThrow(() => formatLocaleList('schedule-pseudo', ['A', 'B']));
});
