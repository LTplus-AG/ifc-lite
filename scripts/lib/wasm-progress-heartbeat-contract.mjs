/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setGeometryProgressCallback } from '../../packages/wasm/pkg/ifc-lite.js';
import { parseMeshesViaPrePass } from './mesh-via-prepass.mjs';

function geometryDigest(collection) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < collection.length; i++) {
    const mesh = collection.get(i);
    for (const array of [mesh.positions, mesh.indices]) {
      const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
      for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
    }
  }
  return `${collection.length}:${collection.totalTriangles}:${hash.toString(16)}`;
}

/**
 * The geometry worker's in-call heartbeat: a real batch call over a model with
 * opening cuts reaches the installed callback from INSIDE the synchronous WASM
 * call, and the callback has no influence on the geometry produced.
 */
export function runProgressHeartbeatContracts(IfcAPI, test, skip, root) {
  const fixture = join(root, 'tests/models/ara3d/AC20-FZK-Haus.ifc');
  const name = 'geometry progress callback fires inside a batch call and leaves output unchanged';
  if (!existsSync(fixture)) {
    skip(name, 'run `pnpm fixtures` to fetch AC20-FZK-Haus');
    return;
  }
  test(name, () => {
    const content = readFileSync(fixture, 'utf8');
    const run = () => {
      const api = new IfcAPI();
      try {
        const collection = parseMeshesViaPrePass(api, content);
        try {
          return geometryDigest(collection);
        } finally {
          collection.free();
        }
      } finally {
        api.free();
      }
    };
    let calls = 0;
    setGeometryProgressCallback(() => {
      calls++;
    });
    let withHook;
    try {
      withHook = run();
    } finally {
      setGeometryProgressCallback(undefined);
    }
    // Rate-limited to one call a second, but the first progress point of a
    // freshly installed callback always reports.
    assert.ok(calls >= 1, 'a batch with opening cuts must report progress at least once');
    const callsAfterRemoval = calls;
    const withoutHook = run();
    assert.equal(calls, callsAfterRemoval, 'a removed callback is never invoked');
    assert.equal(withoutHook, withHook, 'the heartbeat must not change any produced geometry');
  });
}
