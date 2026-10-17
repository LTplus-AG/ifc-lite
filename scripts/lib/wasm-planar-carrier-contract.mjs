/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseMeshesViaPrePass } from './mesh-via-prepass.mjs';

export function runPlanarCarrierContracts(api, test, root) {
  test('#7714: public WASM batch normalizes the authored shared corner', () => {
    const source = readFileSync(join(root, 'rust/geometry/tests/fixtures/issue_7714_soffice_carrier.ifc'), 'utf8');
    const load = content => {
      const collection = parseMeshesViaPrePass(api, content);
      try {
        assert.equal(collection.length, 1);
        const mesh = collection.get(0);
        try {
          assert.equal(mesh.expressId, 900004);
          const corners = [];
          for (let i = 0; i < mesh.positions.length; i += 3) {
            // Flat WASM output is Y-up: IFC (x,y,z) becomes (x,z,-y).
            const p = [0, 1, 2].map(axis => mesh.positions[i + axis] + (mesh.origin?.[axis] ?? 0));
            if (Math.abs(p[1] + 0.325) < 1e-7 && Math.abs(p[2] + 11.8450000131) < 1e-6 && p[0] < 0.097) corners.push(p);
          }
          assert.ok(corners.length > 0);
          return { corners, triangles: mesh.indices.length / 3 };
        } finally { mesh.free(); }
      } finally { collection.free(); }
    };
    const corrected = load(source);
    const declined = load(source.replace('3,0.01,#80', '3,$,#80'));
    assert.equal(corrected.triangles, declined.triangles);
    assert.ok(corrected.corners.every(p => Math.abs(p[0] - 0.095) < 1e-8));
    assert.ok(declined.corners.every(p => Math.abs(p[0] - 0.0950001680875) < 1e-8));
  });
}
