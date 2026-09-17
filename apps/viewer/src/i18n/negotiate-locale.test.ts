/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { negotiateLocale } from './negotiate-locale';

describe('negotiateLocale (#4785)', () => {
  const available = ['en', 'de', 'fr-CA', 'pt-BR'];

  it('matches exact tags case-insensitively and returns the available spelling', () => {
    assert.equal(negotiateLocale(['PT-br'], available), 'pt-BR');
  });

  it('falls back from a regional request to the bare language', () => {
    assert.equal(negotiateLocale(['de-CH'], available), 'de');
  });

  it('falls back from a request to a regional sibling of the same language', () => {
    assert.equal(negotiateLocale(['fr'], available), 'fr-CA');
    assert.equal(negotiateLocale(['fr-FR'], available), 'fr-CA');
  });

  it('honours request order: an earlier English preference beats a later translated one', () => {
    assert.equal(negotiateLocale(['en-US', 'de'], available), 'en');
    assert.equal(negotiateLocale(['it', 'de'], available), 'de');
  });

  it('matches deprecated or differently cased tags by canonical form, returning the registered tag', () => {
    assert.equal(negotiateLocale(['he-IL'], ['en', 'iw']), 'iw');
    assert.equal(negotiateLocale(['iw'], ['en', 'he']), 'he');
    assert.equal(negotiateLocale(['zh-TW'], ['en', 'zh-hant-tw']), 'zh-hant-tw');
  });

  it('returns null when nothing matches, and skips invalid or blank tags instead of throwing', () => {
    assert.equal(negotiateLocale(['it', 'ja'], available), null);
    const warn = console.warn;
    console.warn = () => {};
    try {
      assert.equal(negotiateLocale(['', '  ', 'not a tag!', 'de'], available), 'de');
    } finally {
      console.warn = warn;
    }
  });
});
