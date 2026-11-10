/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * wkt-parser ships with a local patch (root package.json `pnpm.patchedDependencies`)
 * that maps WKT1/ESRI parameter names inside WKT2 (central_meridian,
 * latitude_of_origin, scale_factor, ...). pnpm ties a patch to one exact version,
 * so a version bump that leaves the patch on the old version breaks install
 * (Dependabot's grouped npm update failed this way on 1.6.0). These checks keep
 * the pin, the patch and the installed package in step, and check that the
 * installed package really carries the fix. Upstream 1.6.0 still lacks it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import parseWkt from 'wkt-parser';

const here = dirname(fileURLToPath(import.meta.url));
const viewerRoot = join(here, '..', '..', '..');
const repoRoot = join(viewerRoot, '..', '..');
const require = createRequire(join(viewerRoot, 'package.json'));

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function patchedWktParserEntry(): [string, string] {
  const pnpm = readJson(join(repoRoot, 'package.json')).pnpm as { patchedDependencies?: Record<string, string> };
  const entries = Object.entries(pnpm?.patchedDependencies ?? {}).filter(([key]) => key.startsWith('wkt-parser@'));
  assert.equal(entries.length, 1, 'exactly one wkt-parser patch is registered');
  return entries[0];
}

describe('wkt-parser patch', () => {
  it('is pinned to the wkt-parser version the viewer declares and installs', () => {
    const [key, patchPath] = patchedWktParserEntry();
    const patchedVersion = key.slice('wkt-parser@'.length);
    const declared = (readJson(join(viewerRoot, 'package.json')).dependencies as Record<string, string>)['wkt-parser'];
    const installed = (require('wkt-parser/package.json') as { version: string }).version;

    assert.equal(declared, patchedVersion, 'apps/viewer pins the exact version the patch was made for');
    assert.equal(installed, patchedVersion, 'the installed wkt-parser is the patched version');
    assert.equal(patchPath, `patches/wkt-parser@${patchedVersion}.patch`);
    assert.ok(existsSync(join(repoRoot, patchPath)), `${patchPath} exists`);
  });

  it('maps WKT1/ESRI parameter names inside WKT2', () => {
    const wkt =
      'PROJCRS["Custom TM",BASEGEOGCRS["WGS 84",DATUM["World Geodetic System 1984",' +
      'ELLIPSOID["WGS 84",6378137,298.257223563]]],CONVERSION["tm",METHOD["Transverse Mercator"],' +
      'PARAMETER["latitude_of_origin",10],PARAMETER["central_meridian",7.5],PARAMETER["scale_factor",0.9996],' +
      'PARAMETER["false_easting",500000],PARAMETER["false_northing",0]],CS[Cartesian,2],' +
      'AXIS["E",east],AXIS["N",north],LENGTHUNIT["metre",1]]';
    const parsed = parseWkt(wkt) as { long0?: number; lat0?: number; k0?: number };

    assert.equal(parsed.long0, 7.5);
    assert.equal(parsed.lat0, 10);
    assert.equal(parsed.k0, 0.9996);
  });
});
