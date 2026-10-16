/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The empty-export rule across the real wasm boundary (#7695,
 * EXPORT-GEOM-9/15), driven by the vectors the Rust exporters are held to
 * (`rust/export/tests/fixtures/empty_export_vectors.json`). A render-geometry
 * entry point (`exportGlb`, `exportObj`, `exportUsd`) must throw an `Error`
 * whose message starts with `NO_RENDER_GEOMETRY`; a data entry point must
 * return a document. Fixture-free: the vectors are inline or git-tracked.
 * The multi-buffer glTF has no wasm entry point, so its vectors are Rust-only.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const decode = (bytes) => new TextDecoder().decode(bytes);

/** Each vector format's wasm entry point; `iso` is the isolation argument. */
const ENTRY_POINTS = {
  glb: (api, b, iso) => api.exportGlb(b, false, new Uint32Array(), iso, ''),
  obj: (api, b, iso) => api.exportObj(b, true, new Uint32Array(), iso),
  usd: (api, b) => api.exportUsd(b),
  csv: (api, b) => api.exportCsv(b, 'entities', '', false),
  json: (api, b) => JSON.parse(decode(api.exportJson(b, false, true, true))),
  jsonld: (api, b) => JSON.parse(decode(api.exportJsonld(b, '', true, true, false, undefined))),
  ifcx: (api, b) => JSON.parse(decode(api.exportIfcx(b, true, false))),
  step: (api, b) => assert.match(decode(api.exportStep(b, '', undefined, '')), /DATA;/),
  hbjson: (api, b) => JSON.parse(decode(api.exportHbjson(b, 'm'))),
  dfjson: (api, b) => JSON.parse(api.exportDfjson(b, 'm')),
};

function outcome(run) {
  try {
    run();
    return 'ok';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return message.startsWith('NO_RENDER_GEOMETRY') ? 'NO_RENDER_GEOMETRY' : `threw: ${message}`;
  }
}

export function runEmptyExportContracts(api, test, root) {
  const vectors = JSON.parse(readFileSync(join(root, 'rust/export/tests/fixtures/empty_export_vectors.json'), 'utf8'));
  for (const c of vectors.cases) {
    const bytes = c.ifc !== undefined ? new TextEncoder().encode(c.ifc) : new Uint8Array(readFileSync(join(root, c.path)));
    const iso = c.isolateNone ? new Uint32Array() : undefined;
    test(`#7695 empty-export vectors at the wasm boundary: ${c.name}`, () => {
      const wrong = [];
      for (const [format, want] of Object.entries(c.expect)) {
        if (format === 'gltf') continue; // no wasm entry point
        const entry = ENTRY_POINTS[format];
        assert.ok(entry, `no wasm entry point mapped for ${format}`);
        const got = outcome(() => entry(api, bytes, iso));
        if (got !== want) wrong.push(`${format}: got ${got}, want ${want}`);
      }
      assert.deepEqual(wrong, [], wrong.join('\n'));
    });
  }
  // The instance must stay usable after a refusal: the error is returned as
  // an `Err`, not thrown with the `&self` borrow held.
  test('#7695: the instance keeps working after a NO_RENDER_GEOMETRY refusal', () => {
    const empty = vectors.cases.find((c) => c.name === 'no-products');
    assert.throws(() => api.exportUsd(new TextEncoder().encode(empty.ifc)), /^Error: NO_RENDER_GEOMETRY/);
    assert.throws(() => api.exportObj(new TextEncoder().encode(empty.ifc), true, new Uint32Array(), undefined), /^Error: NO_RENDER_GEOMETRY/);
    const wall = new Uint8Array(readFileSync(join(root, 'apps/landing/samples/hello-wall.ifc')));
    assert.match(decode(api.exportUsd(wall)), /def Mesh "/);
  });
}
