/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as wasmPkg from '../../packages/wasm/pkg/ifc-lite.js';
import { parseMeshesViaPrePass } from './mesh-via-prepass.mjs';

const MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0M7tQ9Jbj1BAeHd7rqnDmP',$,'Project',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
`;

/**
 * #7677: caller input that used to leave the instance unusable. A throw from
 * inside a `&self` method keeps the handle's borrow flag held, so every later
 * call and `free()` fails; a Rust panic traps the whole instance
 * (`panic = 'abort'`). Both are now ordinary JS errors, or no error at all.
 */
export function runReachablePanicContracts(IfcAPI, test, skip, root) {
  test('#7677 exportMerged refuses malformed lengths and leaves the handle usable and freeable', () => {
    const api = new IfcAPI();
    const one = new TextEncoder().encode(MODEL);
    const two = new Uint8Array(one.length * 2);
    two.set(one, 0);
    two.set(one, one.length);
    assert.throws(() => api.exportMerged(two, new Uint32Array([one.length, one.length + 1]), ''), /^Error: exportMerged: segment lengths exceed concatenated buffer$/);
    assert.throws(() => api.exportMerged(two, new Uint32Array([one.length]), ''), /^Error: exportMerged: segment lengths do not cover the whole buffer$/);
    const merged = new TextDecoder().decode(api.exportMerged(two, new Uint32Array([one.length, one.length]), ''));
    assert.match(merged, /IFCPROJECT/, 'the same handle still merges after two refusals');
    api.free();
  });

  test('#7677 splitMeshByZones refuses a zone past the kernel coordinate bound instead of trapping', () => {
    // A 2 m cube. An Infinity zone (rotated so its corners stay +-Infinity
    // rather than NaN) used to reach the exact kernel and panic; a 1e77 zone
    // returned a wrong split. Both are now `undefined`: no split.
    const positions = Float64Array.from([0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 2, 0, 0, 0, 2, 2, 0, 2, 2, 2, 2, 0, 2, 2]);
    const indices = Uint32Array.from([0, 3, 2, 0, 2, 1, 4, 5, 6, 4, 6, 7, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2]);
    for (const size of [Infinity, 1e77]) {
      const zones = Float64Array.from([1, 1, 1, size, size, size, Math.PI / 4]);
      assert.equal(wasmPkg.splitMeshByZones(positions, indices, zones), undefined, `size ${size}`);
    }
    const split = wasmPkg.splitMeshByZones(positions, indices, Float64Array.from([1, 1, 1, 1e30, 1e30, 1e30, Math.PI / 4]));
    try {
      const piece = split.piece(0);
      try {
        assert.equal(piece.zoneIndex, 0, 'an in-range huge zone still holds the cube');
        assert.ok(Math.abs(piece.volume - 8) < 1e-9, `got ${piece.volume}`);
      } finally {
        piece.free();
      }
    } finally {
      split.free();
    }
  });

  const fixture = join(root, 'tests/models/ara3d/AC20-FZK-Haus.ifc');
  const name = '#7677 a progress callback that clears itself does not abort the instance';
  if (!existsSync(fixture)) {
    skip(name, 'run `pnpm fixtures` to fetch AC20-FZK-Haus');
    return;
  }
  const { setGeometryProgressCallback } = wasmPkg;
  if (typeof setGeometryProgressCallback !== 'function') {
    skip(name, 'wasm pkg predates setGeometryProgressCallback; rebuild with scripts/build-wasm.sh');
    return;
  }
  test(name, () => {
    const content = readFileSync(fixture, 'utf8');
    const meshCount = () => {
      const api = new IfcAPI();
      try {
        const collection = parseMeshesViaPrePass(api, content);
        try {
          return collection.length;
        } finally {
          collection.free();
        }
      } finally {
        api.free();
      }
    };
    let calls = 0;
    // Re-entering the setter from inside the callback used to hit
    // `borrow_mut` on the borrowed callback slot: a panic, so an abort.
    setGeometryProgressCallback(() => {
      calls++;
      setGeometryProgressCallback(undefined);
    });
    let withHook;
    try {
      withHook = meshCount();
    } finally {
      setGeometryProgressCallback(undefined);
    }
    assert.equal(calls, 1, 'the callback ran once and removed itself');
    assert.equal(meshCount(), withHook, 'the instance still produces the same geometry');
  });
}
