/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const wasmPath = join(packageDir, 'pkg', 'ifc-lite_bg.wasm');
const wasmJsPath = join(packageDir, 'pkg', 'ifc-lite.js');
const namespace = 'http://www.landxml.org/schema/LandXML-1.2';
const bytes = new TextEncoder();

function document(breaklines = '') {
  return `<LandXML xmlns="${namespace}" version="1.2"><Units><Metric linearUnit="meter"/></Units><Surfaces><Surface name="grade"><Definition surfType="TIN"><Pnts><P id="1">0 0 0</P><P id="2">0 10 0</P><P id="3">10 10 0</P><P id="4">10 0 0</P></Pnts><Boundaries><Boundary bndType="outer"><PntList3D>0 0 0 0 10 0 10 10 0 10 0 0</PntList3D></Boundary></Boundaries>${breaklines}</Definition></Surface></Surfaces></LandXML>`;
}

describe('@ifc-lite/wasm constrained LandXML terrain (#5043)', () => {
  it('returns generated faces and stable contributor provenance through the real binding', async (t) => {
    if (!existsSync(wasmPath) || !existsSync(wasmJsPath)) {
      t.skip('wasm bundle not built — run `bash scripts/build-wasm.sh` first');
      return;
    }
    const { initSync, IfcAPI } = await import(wasmJsPath);
    initSync(readFileSync(wasmPath));
    const api = new IfcAPI();
    try {
      const source = document().replace(
        '<P id="2">0 10 0</P>',
        '<P id="5">0 0 0</P><P id="2">0 10 0</P>',
      );
      const result = api.parseLandXmlTinBytes(bytes.encode(source));
      const surface = result.surfaces[0];
      assert.equal(surface.topology_origin, 'constrained_triangulation');
      assert.ok(surface.faces.length >= 2, 'the square has generated terrain faces');
      assert.equal(surface.faces.length, surface.face_source_ids.length);
      assert.equal(surface.canonical_vertices.length, 4);
      assert.ok(surface.canonical_vertices.every((vertex) => vertex.contributor_source_ids.length >= 1));
      assert.deepEqual(
        surface.canonical_vertices.find((vertex) => vertex.northing === 0 && vertex.easting === 0).contributor_source_ids,
        [
          'landxml:surface:1:point:1',
          'landxml:surface:1:point:5',
          'landxml:surface:1:boundary:1:point:1',
        ],
      );
    } finally {
      api.free?.();
    }
  });

  it('refuses a crossing breakline through the real binding', async (t) => {
    if (!existsSync(wasmPath) || !existsSync(wasmJsPath)) {
      t.skip('wasm bundle not built — run `bash scripts/build-wasm.sh` first');
      return;
    }
    const { initSync, IfcAPI } = await import(wasmJsPath);
    initSync(readFileSync(wasmPath));
    const api = new IfcAPI();
    try {
      const lines = '<Breaklines><Breakline brkType="standard"><PntList3D>0 0 0 10 10 0</PntList3D></Breakline><Breakline brkType="standard"><PntList3D>0 10 0 10 0 0</PntList3D></Breakline></Breaklines>';
      const result = api.parseLandXmlTinBytes(bytes.encode(document(lines)));
      assert.equal(result.surfaces[0].terrain_diagnostic?.code, 'intersecting_constraints');
      assert.equal(result.surfaces[0].topology_origin, 'preserved_only');
    } finally {
      api.free?.();
    }
  });

  it('keeps SourceData-generated face references resolvable through the real binding', async (t) => {
    if (!existsSync(wasmPath) || !existsSync(wasmJsPath)) { t.skip('wasm bundle not built — run `bash scripts/build-wasm.sh` first'); return; }
    const { initSync, IfcAPI } = await import(wasmJsPath);
    initSync(readFileSync(wasmPath));
    const api = new IfcAPI();
    try {
      const sourceData = '<SourceData><DataPoints><PntList3D>0 0 0 0 10 0 10 10 0 10 0 0</PntList3D></DataPoints></SourceData>';
      const source = document().replace('<Pnts><P id="1">0 0 0</P><P id="2">0 10 0</P><P id="3">10 10 0</P><P id="4">10 0 0</P></Pnts>', '').replace('</Definition>', `</Definition>${sourceData}`);
      const surface = api.parseLandXmlTinBytes(bytes.encode(source)).surfaces[0];
      const ids = new Set(surface.points.map((point) => point.id));
      assert.ok(surface.faces.flat().every((id) => ids.has(id)));
      assert.ok(surface.points.some((point) => point.id.startsWith('terrain:landxml:surface:1:source-point:')));
    } finally { api.free?.(); }
  });
});
