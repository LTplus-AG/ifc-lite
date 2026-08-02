/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Issue #976 step 4/5 — consumer-configurable tessellation quality on the
 * LIVE VIEWER path (`buildPrePassOnce` + `processGeometryBatch`).
 *
 * Three contracts:
 *   1. REGRESSION: never calling `setTessellationQuality` produces output
 *      byte-for-byte identical to an explicit `'medium'` (the enum's identity
 *      level) — existing consumers must see no change.
 *   2. MONOTONIC: a curved element (swept-disk pipe) gains triangles as the
 *      level rises, non-decreasing across all five levels and strictly more
 *      at `'highest'` than `'lowest'`.
 *   3. VALIDATION: an unknown level string throws instead of silently
 *      rendering at the wrong density; `null` resets to the default.
 */

import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const rootDir = join(packageDir, '..', '..');
const wasmPath = join(packageDir, 'pkg', 'ifc-lite_bg.wasm');
const wasmJsPath = join(packageDir, 'pkg', 'ifc-lite.js');

const PIPE_ID = 20;

/** A 2 m straight swept-disk pipe — the tube ring count scales with quality. */
const PIPE_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-976 tessellation quality pipe'),'2;1');
FILE_NAME('t.ifc','2026-06-10T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#10=IFCCARTESIANPOINT((0.,0.,0.));
#11=IFCCARTESIANPOINT((0.,0.,2.));
#12=IFCPOLYLINE((#10,#11));
#13=IFCSWEPTDISKSOLID(#12,0.05,$,$,$);
#14=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#13));
#15=IFCPRODUCTDEFINITIONSHAPE($,$,(#14));
#16=IFCLOCALPLACEMENT($,#5);
#20=IFCFLOWSEGMENT('1pipeOccurrence000000',$,'Pipe',$,$,#16,#15,$);
ENDSEC;
END-ISO-10303-21;
`;

const LEVELS = ['lowest', 'low', 'medium', 'high', 'highest'];

function pipeMeshes(result) {
  const out = [];
  for (let i = 0; i < result.length; i++) {
    const m = result.get(i);
    if (m && m.expressId === PIPE_ID) out.push(m);
  }
  return out;
}

function pipeTriangles(result) {
  return pipeMeshes(result).reduce((n, m) => n + m.triangleCount, 0);
}

async function loadWasm() {
  // pathToFileURL so the dynamic imports also work on Windows, where a bare
  // absolute path is rejected by the ESM loader (`protocol 'd:'`).
  const { initSync, IfcAPI } = await import(pathToFileURL(wasmJsPath).href);
  const { parseMeshesViaPrePass } = await import(
    pathToFileURL(join(rootDir, 'scripts', 'lib', 'mesh-via-prepass.mjs')).href
  );
  initSync(readFileSync(wasmPath));
  return { IfcAPI, parseMeshesViaPrePass };
}

describe('@ifc-lite/wasm setTessellationQuality (#976)', () => {
  it('unset quality is byte-for-byte identical to explicit medium', async (t) => {
    if (!existsSync(wasmPath) || !existsSync(wasmJsPath)) {
      t.skip('wasm bundle not built — run `bash scripts/build-wasm.sh` first');
      return;
    }
    const { IfcAPI, parseMeshesViaPrePass } = await loadWasm();

    const apiDefault = new IfcAPI();
    const apiMedium = new IfcAPI();
    try {
      apiMedium.setTessellationQuality('medium');
      const a = pipeMeshes(parseMeshesViaPrePass(apiDefault, PIPE_IFC));
      const b = pipeMeshes(parseMeshesViaPrePass(apiMedium, PIPE_IFC));

      assert.ok(a.length >= 1, 'pipe should produce at least one mesh');
      assert.equal(a.length, b.length, 'same submesh count');
      for (let i = 0; i < a.length; i++) {
        assert.deepEqual(
          Buffer.from(a[i].positions.buffer, a[i].positions.byteOffset, a[i].positions.byteLength),
          Buffer.from(b[i].positions.buffer, b[i].positions.byteOffset, b[i].positions.byteLength),
          'positions must be byte-identical when quality is unset',
        );
        assert.deepEqual(
          Buffer.from(a[i].indices.buffer, a[i].indices.byteOffset, a[i].indices.byteLength),
          Buffer.from(b[i].indices.buffer, b[i].indices.byteOffset, b[i].indices.byteLength),
          'indices must be byte-identical when quality is unset',
        );
        assert.deepEqual(
          Buffer.from(a[i].normals.buffer, a[i].normals.byteOffset, a[i].normals.byteLength),
          Buffer.from(b[i].normals.buffer, b[i].normals.byteOffset, b[i].normals.byteLength),
          'normals must be byte-identical when quality is unset',
        );
      }
    } finally {
      apiDefault.free?.();
      apiMedium.free?.();
    }
  });

  it('curved-pipe triangle counts rise monotonically across levels', async (t) => {
    if (!existsSync(wasmPath) || !existsSync(wasmJsPath)) {
      t.skip('wasm bundle not built — run `bash scripts/build-wasm.sh` first');
      return;
    }
    const { IfcAPI, parseMeshesViaPrePass } = await loadWasm();

    // One reused IfcAPI: the level is API-state consumed by the NEXT
    // processGeometryBatch, which is exactly how the viewer toggles it.
    const api = new IfcAPI();
    try {
      const counts = LEVELS.map((level) => {
        api.setTessellationQuality(level);
        return pipeTriangles(parseMeshesViaPrePass(api, PIPE_IFC));
      });

      for (let i = 1; i < counts.length; i++) {
        assert.ok(
          counts[i - 1] <= counts[i],
          `triangle counts must be non-decreasing across levels: ${JSON.stringify(counts)}`,
        );
      }
      assert.ok(
        counts[0] < counts[counts.length - 1],
        `highest must triangulate strictly finer than lowest: ${JSON.stringify(counts)}`,
      );
    } finally {
      api.free?.();
    }
  });

  it('rejects unknown levels and resets to default on null', async (t) => {
    if (!existsSync(wasmPath) || !existsSync(wasmJsPath)) {
      t.skip('wasm bundle not built — run `bash scripts/build-wasm.sh` first');
      return;
    }
    const { IfcAPI, parseMeshesViaPrePass } = await loadWasm();

    const api = new IfcAPI();
    try {
      assert.throws(
        () => api.setTessellationQuality('ultra'),
        /Unknown tessellation quality/,
        'typos must fail loudly, not render at the wrong density',
      );
      // Case-insensitive parse.
      api.setTessellationQuality('HIGHEST');
      const high = pipeTriangles(parseMeshesViaPrePass(api, PIPE_IFC));
      // null restores the default (medium) density.
      api.setTessellationQuality(null);
      const reset = pipeTriangles(parseMeshesViaPrePass(api, PIPE_IFC));
      assert.ok(reset < high, `null must reset to default density (medium=${reset}, highest=${high})`);
    } finally {
      api.free?.();
    }
  });
});
