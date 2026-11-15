/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The GLB format: exact round trip, plain-glTF readability and lossless origins. */

import { describe, expect, it } from 'vitest';
import { buildSiteContext } from '../src/build.js';
import { decodeSiteContextGlb, SiteContextFormatError } from '../src/glb-decode.js';
import { encodeSiteContextGlb } from '../src/glb-encode.js';
import type { GltfJson } from '../src/glb-format.js';
import { paraboloid, stubGeodata } from './stub-geodata.js';

async function sampleDoc() {
  return buildSiteContext({
    centre: { x: 2_600_000.25, y: 1_199_999.75 },
    radius: 70,
    layers: ['terrain', 'parcel', 'buildings'],
    geodata: stubGeodata({ height: paraboloid, noData: (x, y) => x > 2_600_050 && y > 1_200_050 }),
  });
}

function gltfJson(glb: Uint8Array): GltfJson {
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  return JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + dv.getUint32(12, true))));
}

describe('site-context GLB', () => {
  it('decodes to exactly the document it was encoded from', async () => {
    const doc = await sampleDoc();
    expect(doc.layers.map((l) => l.issues.length).reduce((a, b) => a + b)).toBeGreaterThan(0);
    const back = decodeSiteContextGlb(encodeSiteContextGlb(doc));
    expect(back).toEqual(doc);
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
    expect(meta.layers[2].issues[0].code).toBe('layer-unsupported');
  });

  it('refuses bytes that are not a site-context GLB', () => {
    expect(() => decodeSiteContextGlb(new Uint8Array(40))).toThrow(SiteContextFormatError);
  });
});
