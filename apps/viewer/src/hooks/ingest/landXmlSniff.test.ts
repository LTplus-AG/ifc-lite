/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5233 — the LandXML content sniffer stays deleted.
 *
 * `landXmlSniff.ts` used to also export `isLandXmlContent`, with
 * `decodeXmlHead` and `rootStartTag` helpers, built for #4937's "content
 * sniffing for generic `.xml`" item. Nothing in production ever called them:
 * `useIfcLoader` hands a `.xml` file straight to the authoritative Rust
 * parser, which validates the root element and namespace while streaming and
 * refuses anything else with LXML006/LXML007. The sniffer's own four tests
 * were the only thing that referenced it, which is how it stayed alive.
 *
 * Deleting unreachable code is not observable through behaviour — being
 * unobservable is what made it dead. What IS observable is the module's export
 * surface, and that is what this file pins: a re-added sniffer fails here on
 * the way in, instead of sitting unreachable behind its own passing tests.
 *
 * Deliberately a separate file from `landXmlIngest.test.ts`: this needs no
 * wasm, no fixtures and no parser, and burying a surface assertion inside a
 * thousand-line ingest suite is how it gets deleted by accident next time.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isLandXmlFileName } from './landXmlSniff.js';

describe('landXmlSniff export surface (#5233)', () => {
  it('exports only the filename candidacy check, with no content sniffer', async () => {
    const sniff = await import('./landXmlSniff.js');
    assert.deepEqual(
      Object.keys(sniff).sort(),
      ['isLandXmlFileName'],
      'a content sniffer belongs in the streaming parser, which already owns the root-element and '
      + 'namespace decision; a second copy here would be unreachable by construction',
    );
  });

  it('accepts any .xml name case-insensitively and rejects everything else', () => {
    // The one decision this module still makes, pinned so the deletion above
    // cannot be read as "the whole module was optional".
    assert.equal(isLandXmlFileName('terrain.xml'), true);
    assert.equal(isLandXmlFileName('TERRAIN.XML'), true);
    assert.equal(isLandXmlFileName('Terrain.Xml'), true);
    // `.landxml` is NOT accepted: the load path's candidacy check is `.xml`
    // only, and claiming otherwise here would describe a path that does not
    // exist.
    assert.equal(isLandXmlFileName('terrain.landxml'), false);
    assert.equal(isLandXmlFileName('terrain.ifc'), false);
    assert.equal(isLandXmlFileName('terrain'), false);
    assert.equal(isLandXmlFileName(''), false);
  });
});
