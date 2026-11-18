/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Exercise the real USD boundary with the git-tracked hello-wall fixture. */
export function runUsdExportContracts(api, test, skip, rootDir) {
  const wall = join(rootDir, 'apps/landing/samples/hello-wall.ifc');
  if (!existsSync(wall)) return skip('USD export contracts', 'hello-wall.ifc missing');
  const wallBytes = new Uint8Array(readFileSync(wall));
  const usdBytes = api.exportUsd(wallBytes);
  const usda = usdBytes instanceof Uint8Array ? new TextDecoder().decode(usdBytes) : '';

  test('exportUsd returns a real Z-up USDA stage (/World, meshes, IFC metadata) with no non-finite coords', () => {
    assert.ok(usdBytes instanceof Uint8Array, 'USD should be a Uint8Array');
    assert.ok(usdBytes.length > 100, 'USD should be non-trivial');
    assert.ok(usda.startsWith('#usda 1.0'), 'starts with the USDA magic line');
    assert.match(usda, /upAxis\s*=\s*"Z"/, 'Z-up stage');
    assert.match(usda, /metersPerUnit\s*=\s*1/, 'metres (no scale conversion)');
    assert.ok(usda.includes('def Xform "World"'), 'has the /World root Xform');
    assert.match(usda, /def Mesh "|class Mesh "/, 'authored at least one mesh or prototype');
    assert.match(usda, /point3f\[\] points =/, 'meshes carry local points');
    assert.ok(usda.includes('ifc:class'), 'carries IFC metadata as custom attributes');
    // The IFC source must cross the boundary as real bytes: an empty input would
    // still yield a structurally valid header but zero geometry — caught above.
    // Rust gates non-finite coords out of the stage; assert none slipped through.
    assert.ok(!/(?<![A-Za-z])(nan|-?inf)(?![A-Za-z])/i.test(usda), 'no NaN/Inf tokens in the stage');
  });

  test('exportUsd is deterministic (byte-identical across two calls on the same input)', () => {
    const again = api.exportUsd(wallBytes);
    assert.ok(again instanceof Uint8Array);
    assert.equal(new TextDecoder().decode(again), usda, 'USD export must be deterministic');
  });

}
