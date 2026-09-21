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

const outerBoundary = '<Boundaries><Boundary bndType="outer"><PntList3D>0 0 0 0 10 0 10 10 0 10 0 0</PntList3D></Boundary></Boundaries>';

function generatedArea(surface) {
  const points = new Map(surface.points.map((point) => [point.id, point]));
  return surface.faces.reduce((total, face) => {
    const [a, b, c] = face.map((id) => points.get(id));
    return total + Math.abs((b.northing - a.northing) * (c.easting - a.easting) - (b.easting - a.easting) * (c.northing - a.northing)) / 2;
  }, 0);
}

function hasGeneratedEdge(surface, a, b) {
  const points = new Map(surface.points.map((point) => [point.id, point]));
  return surface.faces.some((face) => face.some((id, index) => {
    const first = points.get(id);
    const second = points.get(face[(index + 1) % 3]);
    const firstCoordinate = [first.northing, first.easting];
    const secondCoordinate = [second.northing, second.easting];
    return (firstCoordinate[0] === a[0] && firstCoordinate[1] === a[1] && secondCoordinate[0] === b[0] && secondCoordinate[1] === b[1]) ||
      (firstCoordinate[0] === b[0] && firstCoordinate[1] === b[1] && secondCoordinate[0] === a[0] && secondCoordinate[1] === a[1]);
  }));
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

  it('covers #5043 constrained topology acceptance through the real binding', async (t) => {
    if (!existsSync(wasmPath) || !existsSync(wasmJsPath)) {
      t.skip('wasm bundle not built — run `bash scripts/build-wasm.sh` first');
      return;
    }
    const { initSync, IfcAPI } = await import(wasmJsPath);
    initSync(readFileSync(wasmPath));
    const api = new IfcAPI();
    try {
      const holeBoundary = '<Boundaries><Boundary bndType="outer"><PntList3D>0 0 0 0 10 0 10 10 0 10 0 0</PntList3D></Boundary><Boundary bndType="hole"><PntList3D>4 4 0 4 6 0 6 6 0 6 4 0</PntList3D></Boundary></Boundaries>';
      const breakline = '<Breaklines><Breakline brkType="standard"><PntList3D>0 2 0 10 2 0</PntList3D></Breakline></Breaklines>';
      const constrained = document(breakline).replace(outerBoundary, holeBoundary);
      const first = api.parseLandXmlTinBytes(bytes.encode(constrained)).surfaces[0];
      const second = api.parseLandXmlTinBytes(bytes.encode(constrained)).surfaces[0];
      assert.deepEqual(first, second, 'repeated parsing is deterministic in WASM');
      assert.equal(first.topology_origin, 'constrained_triangulation');
      assert.ok(Math.abs(generatedArea(first) - 96) < 1e-9, 'outer minus hole area is exact');
      for (const [a, b] of [
        [[0, 0], [0, 2]], [[0, 2], [0, 10]], [[0, 10], [10, 10]],
        [[10, 10], [10, 2]], [[10, 2], [10, 0]], [[10, 0], [0, 0]],
        [[4, 4], [4, 6]], [[4, 6], [6, 6]], [[6, 6], [6, 4]], [[6, 4], [4, 4]],
        [[0, 2], [10, 2]],
      ]) assert.ok(hasGeneratedEdge(first, a, b), `constraint edge ${a}–${b} survives`);

      const disconnected = '<Boundaries><Boundary bndType="outer"><PntList3D>0 0 0 0 2 0 2 2 0 2 0 0</PntList3D></Boundary><Boundary bndType="outer"><PntList3D>10 10 0 10 12 0 12 12 0 12 10 0</PntList3D></Boundary></Boundaries>';
      const islands = api.parseLandXmlTinBytes(bytes.encode(document().replace(outerBoundary, disconnected))).surfaces[0];
      assert.equal(islands.topology_origin, 'constrained_triangulation');
      assert.ok(Math.abs(generatedArea(islands) - 8) < 1e-9, 'disconnected outer islands do not bridge');

      const split = '<Breaklines><Breakline brkType="standard"><PntList3D>0 5 0 10 5 0</PntList3D></Breakline></Breaklines>';
      const splitSurface = api.parseLandXmlTinBytes(bytes.encode(document(split))).surfaces[0];
      for (const [a, b] of [
        [[0, 0], [0, 5]], [[0, 5], [0, 10]], [[0, 5], [10, 5]],
        [[10, 0], [10, 5]], [[10, 5], [10, 10]],
      ]) assert.ok(hasGeneratedEdge(splitSurface, a, b), `boundary/breakline split ${a}–${b} survives`);

      const slope = `<LandXML xmlns="${namespace}" version="1.2"><Units><Metric linearUnit="meter"/></Units><Surfaces><Surface name="slope"><Definition surfType="TIN"><Boundaries><Boundary bndType="outer"><PntList3D>0 0 0 0 10 20 10 10 30 10 0 10</PntList3D></Boundary></Boundaries><Breaklines><Breakline brkType="standard"><PntList3D>0 5 10 5 5.000000000001 15.000000000002 10 5 20</PntList3D></Breakline></Breaklines></Definition></Surface></Surfaces></LandXML>`;
      const slopeSurface = api.parseLandXmlTinBytes(bytes.encode(slope)).surfaces[0];
      const points = new Map(slopeSurface.points.map((point) => [point.id, point]));
      assert.ok(Math.abs(generatedArea(slopeSurface) - 100) < 1e-9);
      for (const face of slopeSurface.faces) {
        const vertices = face.map((id) => points.get(id));
        const areaTwice = (vertices[1].northing - vertices[0].northing) * (vertices[2].easting - vertices[0].easting) - (vertices[1].easting - vertices[0].easting) * (vertices[2].northing - vertices[0].northing);
        assert.ok(Math.abs(areaTwice) > 1e-12, 'near-collinear face remains non-degenerate');
        const weights = [0.2, 0.3, 0.5];
        const northing = vertices.reduce((sum, point, index) => sum + weights[index] * point.northing, 0);
        const easting = vertices.reduce((sum, point, index) => sum + weights[index] * point.easting, 0);
        const elevation = vertices.reduce((sum, point, index) => sum + weights[index] * point.elevation, 0);
        assert.ok(Math.abs(elevation - (northing + 2 * easting)) < 1e-9, 'barycentric known-slope elevation is preserved');
      }

      // z = easting gives an exact source height of 1 at this split vertex,
      // although binary64 affine interpolation rounds it to 0.9999999999999999.
      const affineSplit = `<LandXML xmlns="${namespace}" version="1.2"><Units><Metric linearUnit="meter"/></Units><Surfaces><Surface name="affine"><Definition surfType="TIN"><Boundaries><Boundary bndType="outer"><PntList3D>0 0 0 0 49 49 10 49 49 10 0 0</PntList3D></Boundary></Boundaries><Breaklines><Breakline brkType="standard"><PntList3D>0 1 1 10 1 1</PntList3D></Breakline></Breaklines></Definition></Surface></Surfaces></LandXML>`;
      const affineSurface = api.parseLandXmlTinBytes(bytes.encode(affineSplit)).surfaces[0];
      assert.equal(affineSurface.topology_origin, 'constrained_triangulation');
      assert.equal(affineSurface.terrain_diagnostic, undefined);
      assert.ok(hasGeneratedEdge(affineSurface, [0, 1], [10, 1]));
      assert.ok(Math.abs(generatedArea(affineSurface) - 490) < 1e-9);

      const overflowingAffineConflict = `<LandXML xmlns="${namespace}" version="1.2"><Units><Metric linearUnit="meter"/></Units><Surfaces><Surface name="overflow"><Definition surfType="TIN"><Boundaries><Boundary bndType="outer"><PntList3D>0 0 -1e308 0 10 1e308 10 10 1e308 10 0 -1e308</PntList3D></Boundary></Boundaries><Breaklines><Breakline brkType="standard"><PntList3D>0 5 1e307 10 5 1e307</PntList3D></Breakline></Breaklines></Definition></Surface></Surfaces></LandXML>`;
      const overflowingSurface = api.parseLandXmlTinBytes(bytes.encode(overflowingAffineConflict)).surfaces[0];
      assert.equal(overflowingSurface.topology_origin, 'preserved_only');
      assert.equal(overflowingSurface.terrain_diagnostic?.code, 'conflicting_elevation');
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

  it('refuses a boundary vertex touching a nonadjacent boundary edge through the real binding', async (t) => {
    if (!existsSync(wasmPath) || !existsSync(wasmJsPath)) { t.skip('wasm bundle not built — run `bash scripts/build-wasm.sh` first'); return; }
    const { initSync, IfcAPI } = await import(wasmJsPath);
    initSync(readFileSync(wasmPath));
    const api = new IfcAPI();
    try {
      const original = '<Boundaries><Boundary bndType="outer"><PntList3D>0 0 0 0 10 0 10 10 0 10 0 0</PntList3D></Boundary></Boundaries>';
      const touching = '<Boundaries><Boundary bndType="outer"><PntList3D>0 0 0 0 4 0 4 4 0 0 2 0 4 0 0</PntList3D></Boundary></Boundaries>';
      const surface = api.parseLandXmlTinBytes(bytes.encode(document().replace(original, touching))).surfaces[0];
      assert.equal(surface.terrain_diagnostic?.code, 'degenerate_constraints');
      assert.equal(surface.topology_origin, 'preserved_only');
    } finally { api.free?.(); }
  });

  it('keeps legal boundary breakline junctions and near-collinear elevations renderable', async (t) => {
    if (!existsSync(wasmPath) || !existsSync(wasmJsPath)) { t.skip('wasm bundle not built — run `bash scripts/build-wasm.sh` first'); return; }
    const { initSync, IfcAPI } = await import(wasmJsPath);
    initSync(readFileSync(wasmPath));
    const api = new IfcAPI();
    try {
      const junction = '<Breaklines><Breakline brkType="standard"><PntList3D>0 5 0 5 5.000000000001 2</PntList3D></Breakline></Breaklines>';
      const surface = api.parseLandXmlTinBytes(bytes.encode(document(junction))).surfaces[0];
      assert.equal(surface.topology_origin, 'constrained_triangulation');
      assert.ok(surface.faces.length >= 2);
      assert.equal(surface.points.find((point) => point.northing === 5 && point.easting === 5.000000000001)?.elevation, 2);
    } finally { api.free?.(); }
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
