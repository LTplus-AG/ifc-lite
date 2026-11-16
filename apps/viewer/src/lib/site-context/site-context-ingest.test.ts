/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A recorded site context (ETH Hönggerberg, 2 m radius, fetched live from
 * geo.admin.ch on 2026-11-15) through the viewer's ingest: written as the CLI
 * writes it (one GLB, every category), recognised from the 4 KiB head the
 * loader reads, split one model per category, and turned into the tabular
 * store the properties panel reads. The parcel's real cadastral attributes
 * must reach `Pset_LandRegistration` unchanged.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { decodeSiteContextGlb, encodeSiteContextGlb, type SiteContextDocument } from '@ifc-lite/site-context';
import { isValidIfcGuid } from '@ifc-lite/encoding';
import { planSiteContextLoad } from '@/hooks/ingest/siteContextLoad';
import { isSiteContextGlbHead, splitSiteContextDocument } from './site-context-glb';
import { SITE_CONTEXT_PROVENANCE_PSET, SITE_CONTEXT_PSET, siteContextViewerModel, terrainPlanBox } from './site-context-model';
import { PARCEL_DISPLAY_LIFT, parcelCasing, parcelDisplayWidth, widenParcelRibbon } from './parcel-outline';

interface RecordedMesh { positions: number[]; normals: number[]; uvs?: number[]; indices: number[] }

function recordedDocument(): SiteContextDocument {
  const raw = JSON.parse(readFileSync(new URL('./fixtures/eth-hoenggerberg-r2.json', import.meta.url), 'utf8')) as {
    document: Omit<SiteContextDocument, 'layers'> & { layers: Array<Omit<SiteContextDocument['layers'][number], 'features'> & {
      features: Array<Omit<SiteContextDocument['layers'][number]['features'][number], 'mesh'> & { mesh: RecordedMesh | null }>;
    }> };
  };
  return {
    ...raw.document,
    layers: raw.document.layers.map((layer) => ({
      ...layer,
      features: layer.features.map((feature) => ({
        ...feature,
        mesh: feature.mesh && {
          positions: Float32Array.from(feature.mesh.positions),
          normals: Float32Array.from(feature.mesh.normals),
          ...(feature.mesh.uvs ? { uvs: Float32Array.from(feature.mesh.uvs) } : {}),
          indices: Uint32Array.from(feature.mesh.indices),
        },
      })),
    })),
  };
}

test('a CLI-written context GLB is recognised from its head and nothing else is', () => {
  const glb = encodeSiteContextGlb(recordedDocument());
  assert.equal(isSiteContextGlbHead(glb.subarray(0, 4096)), true);
  // A plain glTF binary, and the same bytes with the marker renamed, are ordinary GLBs.
  const plain = glb.slice(0, 4096);
  const text = new TextDecoder().decode(plain);
  const renamed = new TextEncoder().encode(text.replace('ifcLiteSiteContext', 'ifcLiteSomethingElse'));
  assert.equal(isSiteContextGlbHead(renamed), false);
  assert.equal(isSiteContextGlbHead(new Uint8Array([1, 2, 3])), false);
});

test('one GLB with every category splits into one single-category GLB per category, frame kept', () => {
  const doc = recordedDocument();
  const parts = splitSiteContextDocument(decodeSiteContextGlb(encodeSiteContextGlb(doc)));
  assert.deepEqual(parts.map((part) => part.kind), ['terrain', 'parcel']);
  for (const part of parts) {
    const single = decodeSiteContextGlb(part.bytes);
    assert.deepEqual(single.origin, doc.origin);
    assert.deepEqual(single.layers.map((layer) => layer.kind), [part.kind]);
  }
  // Recorded at 2 m the parcel boundary lies outside the site: it has data, no geometry, and says why.
  const plan = planSiteContextLoad(doc);
  assert.equal(plan.here?.kind, 'terrain');
  assert.deepEqual(plan.empty.map((layer) => layer.kind), ['parcel']);
  assert.deepEqual(plan.empty[0].issues.map((issue) => issue.code), ['parcel-undraped-vertices', 'terms-unverified']);
});

test('the parcel reaches the properties panel as an IfcSite with its real Pset_LandRegistration', () => {
  const doc = decodeSiteContextGlb(encodeSiteContextGlb(recordedDocument()));
  const parcel = doc.layers.find((layer) => layer.kind === 'parcel')!;
  const { dataStore } = siteContextViewerModel(doc, parcel, new ArrayBuffer(8), 0);
  const [site] = dataStore.getEntitiesByType('IfcSite');
  assert.equal(site.expressId, 1);
  assert.equal(dataStore.entities.getName(1), 'Parcel HG8368 (CH186999917893)');
  assert.equal(isValidIfcGuid(dataStore.entities.getGlobalId(1)), true);
  assert.equal(dataStore.properties.getPropertyValue(1, 'Pset_LandRegistration', 'LandID'), 'CH186999917893');
  assert.equal(dataStore.properties.getPropertyValue(1, 'Pset_LandRegistration', 'LandTitleID'), 'HG8368');
  assert.equal(dataStore.properties.getPropertyValue(1, SITE_CONTEXT_PSET, 'canton'), 'ZH');
  assert.equal(dataStore.properties.getPropertyValue(1, SITE_CONTEXT_PSET, 'oerebExtractUrl'), 'https://maps.zh.ch/oereb/v2/extract/url/?EGRID=CH186999917893');
  assert.equal(dataStore.properties.getPropertyValue(1, SITE_CONTEXT_PROVENANCE_PSET, 'dataset'), 'cadastre');
  // The project root carries the attribution the card and export can read.
  const [project] = dataStore.getEntitiesByType('IfcProject');
  assert.match(String(dataStore.properties.getPropertyValue(project.expressId, SITE_CONTEXT_PSET, 'Attribution')), /Cadastral surveying/);
  assert.equal(dataStore.properties.getPropertyValue(project.expressId, SITE_CONTEXT_PSET, 'Complete'), false);
});

test('terrain chunks become IfcGeographicElement meshes in viewer axes at their own f64 origins', () => {
  const doc = decodeSiteContextGlb(encodeSiteContextGlb(recordedDocument()));
  const terrain = doc.layers.find((layer) => layer.kind === 'terrain')!;
  const { dataStore, geometryResult, spatialReference } = siteContextViewerModel(doc, terrain, new ArrayBuffer(8), 0);
  assert.equal(dataStore.getEntitiesByType('IfcGeographicElement').length, terrain.features.length);
  assert.equal(dataStore.properties.getPropertyValue(1, SITE_CONTEXT_PSET, 'PredefinedType'), 'TERRAIN');
  assert.equal(dataStore.spatialHierarchy?.project.children.length, 1, 'chunks sit in one IfcSite under the project');
  assert.equal(spatialReference.horizontal?.id, 'EPSG:2056');
  assert.equal(spatialReference.vertical?.id, 'EPSG:5728');
  assert.deepEqual([spatialReference.localToProjected?.eastings, spatialReference.localToProjected?.northings], [doc.origin[0], doc.origin[1]]);
  // Every vertex: viewer (x, y, z) = (E − E0, H − H0, −(N − N0)), exactly.
  const feature = terrain.features[0];
  const mesh = geometryResult.meshes[0];
  for (let i = 0; i < feature.mesh!.positions.length; i += 3) {
    const [e, n, h] = [feature.origin[0] + feature.mesh!.positions[i], feature.origin[1] + feature.mesh!.positions[i + 1], feature.origin[2] + feature.mesh!.positions[i + 2]];
    assert.ok(mesh.origin![0] + mesh.positions[i] === e - doc.origin[0], `vertex ${i / 3} axis 0`);
    assert.ok(mesh.origin![1] + mesh.positions[i + 1] === h - doc.origin[2], `vertex ${i / 3} axis 1`);
    assert.ok(mesh.origin![2] + mesh.positions[i + 2] === -(n - doc.origin[1]), `vertex ${i / 3} axis 2`);
  }
  // The chunk keeps its UVs for the drape; the skirt does not (imagery stays off its walls).
  assert.ok(mesh.uvs);
  assert.equal(geometryResult.meshes.find((candidate) => candidate.expressId === 2)?.uvs, undefined);
  const box = terrainPlanBox(terrain)!;
  assert.ok(box[0] <= 2_680_698 && box[2] >= 2_680_702 && box[1] <= 1_251_418 && box[3] >= 1_251_422, `plan box ${box.join(', ')}`);
});

test('the parcel line widens with the site: a clear line at 300 and 500 m, not fat at 100 m', () => {
  // About three pixels when a top view frames the whole site (site width / ~1000 px).
  assert.ok(Math.abs(parcelDisplayWidth(100) - 0.66) < 1e-9);
  assert.ok(Math.abs(parcelDisplayWidth(300) - 1.98) < 1e-9);
  assert.ok(Math.abs(parcelDisplayWidth(500) - 3.3) < 1e-9);
  assert.equal(parcelDisplayWidth(20), 0.6);
  assert.equal(parcelDisplayWidth(5000), 3.5);
});

// One core ribbon quad across a boundary on a 10 % cross-slope: pairs (left, right) at x = 0 and x = 5.
const core = new Float32Array([0, 0.15, 1.015, 0, -0.15, 0.985, 5, 0.15, 1.015, 5, -0.15, 0.985]);
const coreIndices = new Uint32Array([1, 3, 2, 1, 2, 0]);

test('the parcel line is widened about its centre line, lifted, and keeps the terrain cross-slope', () => {
  const width = 2;
  const wide = widenParcelRibbon(core, width);
  for (const i of [0, 6]) {
    assert.ok(Math.abs(Math.hypot(wide[i] - wide[i + 3], wide[i + 1] - wide[i + 4]) - width) < 1e-5);
    assert.ok(Math.abs((wide[i + 1] + wide[i + 4]) / 2) < 1e-6, 'centre line unchanged in plan');
    assert.ok(Math.abs((wide[i + 2] + wide[i + 5]) / 2 - (1 + PARCEL_DISPLAY_LIFT)) < 1e-5, 'centre lifted');
    assert.ok(Math.abs((wide[i + 2] - wide[i + 5]) / (wide[i + 1] - wide[i + 4]) - 0.1) < 1e-4, 'cross-slope kept');
  }
});

test('the dark casing runs along both sides of the line, outside it, never over it', () => {
  const width = 2, casingWidth = 0.5;
  const casing = parcelCasing(core, coreIndices, width, casingWidth);
  assert.equal(casing.positions.length, 2 * 4 * 3, 'four vertices per pair');
  assert.equal(casing.indices.length, 12, 'two strips of two triangles for the one quad');
  // Cross-boundary offsets (y) of the four vertices of the first pair: outer-left, inner-left, inner-right, outer-right.
  const ys = [0, 1, 2, 3].map((v) => casing.positions[v * 3 + 1]);
  [width / 2 + casingWidth, width / 2, -width / 2, -width / 2 - casingWidth].forEach((expected, k) => assert.ok(Math.abs(ys[k] - expected) < 1e-5, `vertex ${k}: ${ys[k]}`));
  // No casing triangle spans the line's interior (|y| < width / 2): every triangle sits on one side.
  for (let t = 0; t < casing.indices.length; t += 3) {
    const sides = [0, 1, 2].map((k) => Math.sign(casing.positions[casing.indices[t + k] * 3 + 1]));
    assert.ok(sides.every((side) => side === sides[0]), `triangle ${t / 3} crosses the line`);
  }
});
