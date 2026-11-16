/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The GLB format: exact round trip, plain-glTF readability and lossless origins. */

import { beforeAll, describe, expect, it } from 'vitest';
import { resolveCrs } from '@ifc-lite/geo';
import { buildSiteContext } from '../src/build.js';
import { decodeSiteContextGlb, SiteContextFormatError } from '../src/glb-decode.js';
import { encodeSiteContextGlb } from '../src/glb-encode.js';
import type { GltfJson } from '../src/glb-format.js';
import { paraboloid, stubGeodata } from './stub-geodata.js';
import { prismFeature, stubReader } from './tiles-support.js';
import { expectSameDocument } from './same-document.js';

async function sampleDoc() {
  return buildSiteContext({
    centre: { x: 2_600_000.25, y: 1_199_999.75 },
    radius: 70,
    layers: ['terrain', 'parcel', 'buildings'],
    geodata: stubGeodata({ height: paraboloid, noData: (x, y) => x > 2_600_050 && y > 1_200_050 }),
    subject: { egid: '42' },
    buildings: {
      reader: stubReader([
        prismFeature({ ring: [[2_599_990, 1_199_990], [2_600_010, 1_199_990], [2_600_010, 1_200_000], [2_599_990, 1_200_000]], base: 595, top: 607, attributes: { EGID: 42, DACH_MAX: 607 } }, 0),
        prismFeature({ ring: [[2_600_030, 1_200_020], [2_600_045, 1_200_020], [2_600_045, 1_200_035], [2_600_030, 1_200_035]], base: 597, top: 604 }, 1),
      ]),
    },
  });
}

function gltfJson(glb: Uint8Array): GltfJson {
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  return JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + dv.getUint32(12, true))));
}

describe('site-context GLB', () => {
  // One-time setup outside the tests' 5 s budget: @ifc-lite/geo builds its EPSG:2056 transformer on
  // first use (about 0.24 s locally, warm disk). 30 s is generous on purpose: this is not a
  // performance check, only a guard against a hang.
  beforeAll(async () => {
    await resolveCrs({ epsg: 2056 });
  }, 30_000);

  it('decodes to exactly the document it was encoded from', async () => {
    const doc = await sampleDoc();
    expect(doc.layers.map((l) => l.issues.length).reduce((a, b) => a + b)).toBeGreaterThan(0);
    const back = decodeSiteContextGlb(encodeSiteContextGlb(doc));
    expectSameDocument(back, doc);
  });

  it('the exact comparison still sees one flipped bit in a mesh and one changed attribute', async () => {
    const doc = await sampleDoc();
    const flipped = decodeSiteContextGlb(encodeSiteContextGlb(doc));
    const positions = flipped.layers[0].features[0].mesh!.positions;
    new Uint8Array(positions.buffer, positions.byteOffset, 4)[0] ^= 1;
    expect(() => expectSameDocument(flipped, doc)).toThrow(/typed array/);
    const renamed = decodeSiteContextGlb(encodeSiteContextGlb(doc));
    renamed.layers[0].features[0].name += ' ';
    expect(() => expectSameDocument(renamed, doc)).toThrow();
  });

  it('is a valid plain glTF 2.0 binary: header, chunks, one node per feature, POSITION bounds', async () => {
    const doc = await sampleDoc();
    const glb = encodeSiteContextGlb(doc);
    const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
    expect(dv.getUint32(0, true)).toBe(0x46546c67);
    expect(dv.getUint32(4, true)).toBe(2);
    expect(dv.getUint32(8, true)).toBe(glb.byteLength);
    expect(glb.byteLength % 4).toBe(0);
    const json = gltfJson(glb);
    expect(json.asset.version).toBe('2.0');
    const featureCount = doc.layers.reduce((n, l) => n + l.features.length, 0);
    const featureNodes = json.nodes!.filter((n) => n.extras?.ifcLiteSiteContext);
    expect(featureNodes).toHaveLength(featureCount);
    for (const mesh of json.meshes!) {
      const pos = json.accessors![mesh.primitives[0].attributes.POSITION];
      expect(pos.min).toHaveLength(3);
      expect(pos.max).toHaveLength(3);
    }
    const binLength = dv.getUint32(20 + dv.getUint32(12, true), true);
    for (const v of json.bufferViews!) {
      expect((v.byteOffset ?? 0) % 4).toBe(0);
      expect((v.byteOffset ?? 0) + v.byteLength).toBeLessThanOrEqual(binLength);
    }
  });

  it('writes node translations that recover each feature origin exactly, in glTF Y-up axes', async () => {
    const doc = await sampleDoc();
    const json = gltfJson(encodeSiteContextGlb(doc));
    const meta = json.asset.extras!.ifcLiteSiteContext!;
    expect(meta).toMatchObject({ formatVersion: 1, crs: 'EPSG:2056', verticalCrs: 'EPSG:5728', origin: doc.origin });
    const [e0, n0, h0] = doc.origin;
    for (const node of json.nodes!) {
      const x = node.extras?.ifcLiteSiteContext as { origin: number[] } | undefined;
      if (!x) continue;
      const t = node.translation!;
      expect([e0 + t[0], n0 - t[2], h0 + t[1]]).toEqual(x.origin);
    }
  });

  it('carries attribution, issues and completeness per layer', async () => {
    const doc = await sampleDoc();
    const meta = gltfJson(encodeSiteContextGlb(doc)).asset.extras!.ifcLiteSiteContext!;
    expect(meta.layers.map((l) => [l.kind, l.complete])).toEqual(doc.layers.map((l) => [l.kind, l.complete]));
    expect(meta.layers[1].attribution.some((a) => a.termsVerifiedOn === null)).toBe(true);
    expect(meta.layers[2].attribution[0].text).toBe('© swisstopo (swissBUILDINGS3D)');
    expect(meta.layers[2].provenance).toEqual(doc.layers[2].provenance);
  });

  it('carries building parts as index ranges of one primitive, and the subject flag, through the round trip', async () => {
    const doc = await sampleDoc();
    const buildings = doc.layers[2].features;
    expect(buildings.map((f) => f.mesh!.parts!.map((p) => p.name))).toEqual([['roof', 'wall'], ['roof', 'wall']]);
    expect(buildings.map((f) => f.subject)).toEqual([true, undefined]);
    const glb = encodeSiteContextGlb(doc);
    const json = gltfJson(glb);
    const meshes = json.meshes!.filter((m) => m.extras?.ifcLiteSiteContext);
    expect(meshes).toHaveLength(2);
    // One primitive with every index: a reader that ignores the extras still gets the whole building.
    for (const m of meshes) {
      expect(m.primitives).toHaveLength(1);
      const parts = m.extras!.ifcLiteSiteContext!.parts;
      expect(json.accessors![m.primitives[0].indices].count).toBe(parts.reduce((n, p) => n + p.indexCount, 0));
    }
    // Terrain and parcel meshes carry no parts and nodes no subject: those layers are written as before.
    expect(json.meshes!.filter((m) => !m.extras)).toHaveLength(json.meshes!.length - 2);
    expect(json.nodes!.filter((n) => (n.extras?.ifcLiteSiteContext as { subject?: boolean } | undefined)?.subject)).toHaveLength(1);
    const back = decodeSiteContextGlb(glb);
    expect(back.layers[2].features).toEqual(buildings);
  });

  it('decodes a file written before parts, subject and layer provenance existed', async () => {
    const doc = await sampleDoc();
    const json = gltfJson(encodeSiteContextGlb(doc));
    // Strip what this change added: what is left is a format 1 file as the earlier encoder wrote it.
    for (const m of json.meshes!) delete m.extras;
    for (const n of json.nodes!) delete (n.extras?.ifcLiteSiteContext as { subject?: boolean } | undefined)?.subject;
    for (const l of json.asset.extras!.ifcLiteSiteContext!.layers) delete l.provenance;
    const glb = encodeSiteContextGlb(doc);
    const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
    const jsonLength = dv.getUint32(12, true);
    const bin = glb.subarray(20 + jsonLength);
    const text = new TextEncoder().encode(JSON.stringify(json));
    const padded = new Uint8Array(Math.ceil(text.length / 4) * 4).fill(0x20);
    padded.set(text);
    const old = new Uint8Array(20 + padded.length + bin.length);
    const ov = new DataView(old.buffer);
    ov.setUint32(0, 0x46546c67, true);
    ov.setUint32(4, 2, true);
    ov.setUint32(8, old.length, true);
    ov.setUint32(12, padded.length, true);
    ov.setUint32(16, 0x4e4f534a, true);
    old.set(padded, 20);
    old.set(bin, 20 + padded.length);
    const back = decodeSiteContextGlb(old);
    expectSameDocument(back.layers[0], doc.layers[0]);
    expect(back.layers[2].features.map((f) => [f.subject, f.mesh!.parts, f.mesh!.indices.length])).toEqual(
      doc.layers[2].features.map((f) => [undefined, undefined, f.mesh!.indices.length]),
    );
    expect(back.layers[2].provenance).toBeUndefined();
  });

  it('refuses parts that do not tile the index buffer', async () => {
    const doc = await sampleDoc();
    doc.layers[2].features[0].mesh!.parts![0].indexCount -= 3;
    expect(() => decodeSiteContextGlb(encodeSiteContextGlb(doc))).toThrow(/parts|contiguous/);
  });

  it('refuses bytes that are not a site-context GLB', () => {
    expect(() => decodeSiteContextGlb(new Uint8Array(40))).toThrow(SiteContextFormatError);
  });
});
