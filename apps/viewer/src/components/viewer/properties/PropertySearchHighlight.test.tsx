/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { PropertySearchHighlight } from './PropertySearchHighlight.js';
import { matchesPropertySearch } from './propertySearch.js';

describe('Properties Unicode find highlighting (#5899)', () => {
  it('maps a match after expanded lowercase text back to the original characters', () => {
    assert.equal(matchesPropertySearch('İfoo', 'foo'), true);
    const html = renderToStaticMarkup(<PropertySearchHighlight text="İfoo" query="foo" />);
    assert.match(html, /İ<mark[^>]*>foo<\/mark>/);
    assert.doesNotMatch(html, /<mark[^>]*>oo<\/mark>/);
  });

  it('highlights a whole source character when only part of its fold matches', () => {
    assert.equal(matchesPropertySearch('İ', 'i'), true);
    const html = renderToStaticMarkup(<PropertySearchHighlight text="İ" query="i" />);
    assert.match(html, /<mark[^>]*>İ<\/mark>/);
  });
});
