/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';

export function installSvgCdataEnvironmentConversion(): () => void {
  const originalParser = globalThis.DOMParser;
  // HappyDOM 20's XML parser rejects CDATA in ECharts' valid SVG stylesheet.
  // Only the test parser encodes that same text as XML entities; the actual
  // renderer output, CSS content, elements and geometry remain unchanged.
  globalThis.DOMParser = class extends originalParser {
    override parseFromString(...[source, type]: Parameters<DOMParser['parseFromString']>): Document {
      const encoded = type === 'image/svg+xml' && typeof source === 'string'
        ? source.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_whole, text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'))
        : source;
      const parsed = super.parseFromString(encoded, type);
      if (type === 'image/svg+xml' && typeof source === 'string') {
        const stylesheet = /<style[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/style>/.exec(source);
        if (stylesheet) assert.equal(parsed.querySelector('style')?.textContent, stylesheet[1], 'test XML conversion retains actual renderer CSS text');
      }
      return parsed;
    }
  };
  return () => { globalThis.DOMParser = originalParser; };
}

