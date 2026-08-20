/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getViewerHtml } from '../src/viewer-html.js';

/** Extract the document title, which is where the model name is interpolated. */
function titleOf(html: string): string {
  const m = html.match(/<title>([\s\S]*?)<\/title>/);
  assert.ok(m, 'viewer HTML must contain a <title>');
  return m[1];
}

describe('getViewerHtml — model name escaping', () => {
  it('escapes every HTML-significant character in the model name', () => {
    // Absolute expectation derived from the HTML spec's five named
    // references, not from the implementation's own output.
    const title = titleOf(getViewerHtml(`&<>"'`));
    assert.equal(title, `&amp;&lt;&gt;&quot;&#39; — ifc-lite 3D`);
  });

  // One case per character, so a kill names the character whose escape was
  // dropped instead of hiding behind a single combined string.
  for (const [raw, escaped] of [
    ['&', '&amp;'],
    ['<', '&lt;'],
    ['>', '&gt;'],
    ['"', '&quot;'],
    ["'", '&#39;'],
  ] as const) {
    it(`escapes ${JSON.stringify(raw)} as ${escaped}`, () => {
      assert.equal(titleOf(getViewerHtml(`a${raw}b`)), `a${escaped}b — ifc-lite 3D`);
    });
  }

  it('escapes every occurrence, not just the first', () => {
    // The replacements use /g. Without it only the leading character is
    // escaped and the rest of the name still reaches the parser raw.
    assert.equal(titleOf(getViewerHtml('<<<')), '&lt;&lt;&lt; — ifc-lite 3D');
    assert.equal(titleOf(getViewerHtml('a&b&c')), 'a&amp;b&amp;c — ifc-lite 3D');
  });

  it('escapes the ampersand FIRST so escapes are not double-encoded', () => {
    // If `&` were escaped after `<`, "&lt;" would become "&amp;lt;" and the
    // browser would render the literal text "&lt;" instead of "<".
    const title = titleOf(getViewerHtml('a<b'));
    assert.equal(title, 'a&lt;b — ifc-lite 3D');
    assert.doesNotMatch(title, /&amp;lt;/);
  });

  it('neutralises a script-injecting model name', () => {
    const html = getViewerHtml('</title><script>alert(1)</script>');
    assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
    assert.match(titleOf(html), /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  });

  it('neutralises an attribute-breaking model name', () => {
    // Both quote styles must go: a bare " or ' would escape any attribute
    // context the name is later interpolated into.
    const title = titleOf(getViewerHtml(`x" onload="evil()`));
    assert.equal(title, `x&quot; onload=&quot;evil() — ifc-lite 3D`);
    assert.doesNotMatch(title, /x" onload/);
  });

  it('escapes the name at every interpolation site, not only the title', () => {
    // The name is also written into the loading screen and the info panel.
    // A raw copy anywhere is a live injection point.
    const html = getViewerHtml('<img src=x onerror=alert(1)>');
    assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>/);
    assert.equal(
      html.split('&lt;img src=x onerror=alert(1)&gt;').length - 1,
      3,
      'the escaped name must appear at all three interpolation sites',
    );
  });

  it('leaves a name with no special characters byte-for-byte intact', () => {
    // The other direction of the binary signal: escaping must not fire on
    // ordinary names, including non-ASCII ones.
    const title = titleOf(getViewerHtml('Büro-Gebäude_v2 (final).ifc'));
    assert.equal(title, 'Büro-Gebäude_v2 (final).ifc — ifc-lite 3D');
  });

  it('accepts an empty model name', () => {
    assert.equal(titleOf(getViewerHtml('')), ' — ifc-lite 3D');
  });

  it('produces a complete standalone HTML document', () => {
    const html = getViewerHtml('m.ifc');
    assert.match(html, /^<!DOCTYPE html>/);
    assert.match(html, /<\/html>\s*$/);
    assert.match(html, /<meta charset="utf-8"\/>/);
  });

  it('references only same-origin assets', () => {
    // The viewer must run offline behind `ifc-lite view`; a CDN <script> or
    // remote <link> would make it fail with no network.
    const html = getViewerHtml('m.ifc');
    assert.doesNotMatch(html, /<script[^>]+src=["']https?:/i);
    assert.doesNotMatch(html, /<link[^>]+href=["']https?:/i);
  });
});

describe('getViewerHtml — pick-info rendering does not use unescaped innerHTML', () => {
  // showPickInfo renders `info.ifcType`, a value read from the streamed mesh
  // data the viewer receives at runtime (from a loaded IFC file or a
  // /api/create call). Every other dynamic value in this file is written via
  // `.textContent`; this function alone used to build markup by
  // string-concatenating into `.innerHTML`, which parses `<`/`&` in the
  // interpolated value as markup instead of text. Pin the safer sibling
  // pattern here since showPickInfo touches `document` and so falls outside
  // the browser-free blob-extraction harness in viewer-html-runtime.test.ts.
  it('does not assign to innerHTML anywhere in showPickInfo', () => {
    const html = getViewerHtml('m.ifc');
    const m = html.match(/function showPickInfo\(eid\) \{[\s\S]*?\n\}/);
    assert.ok(m, 'showPickInfo not found in the viewer script');
    assert.doesNotMatch(
      m[0],
      /\.innerHTML\s*=/,
      'showPickInfo must build the pick-info panel without innerHTML string concatenation',
    );
  });
});
