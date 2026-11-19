/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { sanitizeProj4 } from './sanitize-proj4.js';

describe('sanitizeProj4 datum shift (#1357)', () => {
  const SJTSK = '+towgs84=570.8,85.7,462.8,4.998,1.587,5.261,3.56';

  it('adds the datum +towgs84 to an offset-datum def that lacks any shift (e.g. Ferro Krovak EPSG:2065)', () => {
    const ferro = '+proj=krovak +axis=swu +lat_0=49.5 +lon_0=42.5 +alpha=30.2881397527778 '
      + '+k=0.9999 +x_0=0 +y_0=0 +ellps=bessel +pm=ferro +units=m +no_defs';
    // The bundled EPSG index (packages/data) reports this code's datum as
    // "S-JTSK (Ferro)", not "S-JTSK" — verified against
    // packages/data/src/generated/epsg-index.generated.ts. Using the plain
    // "S-JTSK" name here made this fixture unable to observe a datum-key
    // lookup miss: production always passes the "(Ferro)" form for 2065.
    const out = sanitizeProj4(ferro, '2065', 'S-JTSK (Ferro)').definition;
    assert.ok(out.includes(SJTSK), `expected +towgs84 to be injected, got: ${out}`);
    assert.ok(out.includes('+pm=ferro'), 'must preserve the rest of the definition');
  });

  it('adds the datum +towgs84 for OSGB36 (EPSG:27700) using the bundled index datum name', () => {
    // packages/data's bundled entry for 27700 reports datum "OSGB36" (no
    // space, no "1936"), which must resolve through the same lookup as the
    // 'osgb 1936' key below.
    const OSGB = '+towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489';
    const withGrid = '+proj=tmerc +ellps=airy +nadgrids=OSTN15_NTv2_OSGBtoETRS.gsb +units=m +no_defs';
    const out = sanitizeProj4(withGrid, '27700', 'OSGB36').definition;
    assert.ok(!out.includes('+nadgrids'), 'must drop the unusable grid reference');
    assert.ok(out.includes(OSGB), `expected OSGB36 +towgs84 to be injected, got: ${out}`);
  });

  it('strips an unusable +nadgrids and substitutes the datum +towgs84', () => {
    const withGrid = '+proj=krovak +ellps=bessel +nadgrids=cz_cuzk_CR-2005.tif +units=m +no_defs';
    const out = sanitizeProj4(withGrid, '5514', 'S-JTSK').definition;
    assert.ok(!out.includes('+nadgrids'), 'must drop the grid reference');
    assert.ok(out.includes(SJTSK), 'must add the +towgs84 fallback');
  });

  it('leaves an existing +towgs84 untouched', () => {
    const def = '+proj=utm +zone=33 +ellps=bessel +towgs84=1,2,3,0,0,0,0 +units=m +no_defs';
    assert.equal(sanitizeProj4(def, '9999', 'S-JTSK').definition, def);
  });

  it('leaves a WGS84-aligned def (unknown datum) unchanged', () => {
    const def = '+proj=utm +zone=32 +datum=WGS84 +units=m +no_defs';
    assert.equal(sanitizeProj4(def, '32632', 'WGS 84').definition, def);
  });
});
