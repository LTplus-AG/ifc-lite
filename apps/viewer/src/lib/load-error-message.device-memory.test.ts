/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { GeometryMemoryBudgetError } from '@ifc-lite/geometry';
import { registerLocale, setLocale } from '../i18n/registry.js';
import de from '../i18n/locales/de.js';
import fr from '../i18n/locales/fr.js';
import it_ from '../i18n/locales/it.js';
import ru from '../i18n/locales/ru.js';
import { formatLoadError } from './load-error-message.js';

afterEach(() => setLocale('en'));

// Huge-file stage 1: a load refused because one geometry worker cannot fit the
// device gets its own message, not the generic out-of-memory advice.
const refusal = new GeometryMemoryBudgetError(9734, 6144);

it('says the model needs more memory than the device reports, with both amounts and the way to try anyway', () => {
  const text = formatLoadError(refusal, 'big.ifc');
  assert.match(text, /at least 9\.6 GiB of memory/); // required rounds up
  assert.match(text, /\(6 GiB at most\)/); // available rounds down
  assert.match(text, /Retry to try anyway/);
  assert.doesNotMatch(text, /closing other tabs/);
  assert.doesNotMatch(formatLoadError(new Error('out of memory'), 'big.ifc'), /more than this device/);
});

it('never shows "X, more than X": a load just over the line rounds required up and available down', () => {
  const text = formatLoadError(new GeometryMemoryBudgetError(6148.32, 6144), 'big.ifc');
  assert.match(text, /at least 6\.1 GiB/);
  assert.match(text, /\(6 GiB at most\)/);
});

it('is translated in every shipped locale, with both amounts in the locale\'s number format', () => {
  const locales = { de, fr, it: it_, ru } as const;
  const seen = new Set<string>();
  for (const [locale, catalogue] of Object.entries(locales)) {
    registerLocale(locale as 'de', catalogue);
    setLocale(locale as 'de');
    const text = formatLoadError(refusal, 'big.ifc');
    assert.doesNotMatch(text, /This model needs/, `${locale} falls back to English`);
    // All four shipped locales use a decimal comma.
    assert.ok(text.includes('9,6 GiB'), `${locale}: ${text}`);
    assert.ok(text.includes('6 GiB'), `${locale}: ${text}`);
    seen.add(text);
  }
  assert.equal(seen.size, 4);
});
