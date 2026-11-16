/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #10480 review: a damaged or foreign GLB is refused with
 * `SiteContextFormatError`, never decoded into a document that silently lacks
 * geometry or points past its vertices; and the encoder writes JSON that is
 * valid glTF 2.0 even for an empty layer.
 */

import { describe, expect, it } from 'vitest';
import { buildSiteContext } from '../src/build.js';
import { decodeSiteContextGlb, SiteContextFormatError } from '../src/glb-decode.js';
import { encodeSiteContextGlb } from '../src/glb-encode.js';
import type { GltfJson } from '../src/glb-format.js';
import { stubGeodata } from './stub-geodata.js';

async function smallDoc() {
  return buildSiteContext({ centre: { x: 2_600_000, y: 1_200_000 }, radius: 10, layers: ['terrain', 'parcel'], geodata: stubGeodata() });
}

/** The GLB's JSON and BIN chunks, editable, and a writer that puts them back with consistent headers. */
function split(glb: Uint8Array): { json: GltfJson; bin: Uint8Array } {
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const jsonLength = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength))) as GltfJson;
  if (glb.length < 28 + jsonLength) return { json, bin: new Uint8Array(0) };
  const binLength = dv.getUint32(20 + jsonLength, true);
  return { json, bin: glb.slice(28 + jsonLength, 28 + jsonLength + binLength) };
}
function join(json: GltfJson, bin: Uint8Array, binLengthField = bin.length): Uint8Array {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const padded = new Uint8Array(Math.ceil(text.length / 4) * 4).fill(0x20);
  padded.set(text);
  const out = new Uint8Array(20 + padded.length + 8 + bin.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, out.length, true);
  dv.setUint32(12, padded.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(padded, 20);
  dv.setUint32(20 + padded.length, binLengthField, true);
  dv.setUint32(24 + padded.length, 0x004e4942, true);
  out.set(bin, 28 + padded.length);
  return out;
}

describe('a damaged GLB is refused, not decoded short', () => {
  it('a BIN chunk cut short (the file truncated in transit)', async () => {
    const glb = encodeSiteContextGlb(await smallDoc());
    // The last 4 bytes are gone; the headers still claim the full length.
    expect(() => decodeSiteContextGlb(glb.subarray(0, glb.length - 4))).toThrow(SiteContextFormatError);
  });

  it('an accessor that claims more elements than its buffer view holds', async () => {
    const { json, bin } = split(encodeSiteContextGlb(await smallDoc()));
    const indices = json.meshes![0].primitives[0].indices!;
    json.accessors![indices].count += 3;
    expect(() => decodeSiteContextGlb(join(json, bin))).toThrow(SiteContextFormatError);
  });

  it('an accessor over a buffer view that omits byteLength (#10480 review follow-up)', async () => {
    const { json, bin } = split(encodeSiteContextGlb(await smallDoc()));
    // The last index buffer view: without byteLength, the accessor end must still be checked against the BIN chunk.
    const indexAccessors = json.meshes!.map((m) => m.primitives[0].indices!);
    const last = indexAccessors.reduce((a, b) => ((json.bufferViews![json.accessors![a].bufferView].byteOffset ?? 0) > (json.bufferViews![json.accessors![b].bufferView].byteOffset ?? 0) ? a : b));
    delete (json.bufferViews![json.accessors![last].bufferView] as { byteLength?: number }).byteLength;
    json.accessors![last].count += 3;
    expect(() => decodeSiteContextGlb(join(json, bin))).toThrow(SiteContextFormatError);
  });

  it('an index that points past the vertices', async () => {
    const { json, bin } = split(encodeSiteContextGlb(await smallDoc()));
    const prim = json.meshes![0].primitives[0];
    const view = json.bufferViews![json.accessors![prim.indices!].bufferView];
    new DataView(bin.buffer, bin.byteOffset).setUint32(view.byteOffset ?? 0, json.accessors![prim.attributes.POSITION].count, true);
    expect(() => decodeSiteContextGlb(join(json, bin))).toThrow(SiteContextFormatError);
  });

  it('an accessor of the wrong shape (POSITION as VEC2)', async () => {
    const { json, bin } = split(encodeSiteContextGlb(await smallDoc()));
    json.accessors![json.meshes![0].primitives[0].attributes.POSITION].type = 'VEC2';
    expect(() => decodeSiteContextGlb(join(json, bin))).toThrow(SiteContextFormatError);
  });

  it('a layer whose node is missing, instead of an empty layer still marked complete', async () => {
    const { json, bin } = split(encodeSiteContextGlb(await smallDoc()));
    json.asset.extras!.ifcLiteSiteContext!.layers[0].node = 9999;
    expect(() => decodeSiteContextGlb(join(json, bin))).toThrow(SiteContextFormatError);
  });

  it('a file that requires an extension this reader does not know', async () => {
    const { json, bin } = split(encodeSiteContextGlb(await smallDoc()));
    (json as GltfJson & { extensionsRequired?: string[] }).extensionsRequired = ['KHR_draco_mesh_compression'];
    expect(() => decodeSiteContextGlb(join(json, bin))).toThrow(SiteContextFormatError);
  });

  it('still reads the untouched file', async () => {
    const doc = await smallDoc();
    const { json, bin } = split(encodeSiteContextGlb(doc));
    expect(decodeSiteContextGlb(join(json, bin)).layers.map((l) => l.features.length)).toEqual(doc.layers.map((l) => l.features.length));
  });
});

describe('the encoder writes valid glTF 2.0 JSON for empty layers', () => {
  it('has no empty arrays (glTF requires at least one item where the property is present)', async () => {
    const failing = { ...stubGeodata(), elevationGrid: async () => { throw new Error('STAC unreachable'); }, parcelsAtPoint: async () => [] };
    const doc = await buildSiteContext({ centre: { x: 2_600_000, y: 1_200_000 }, radius: 10, layers: ['terrain', 'parcel'], geodata: failing });
    expect(doc.layers.every((l) => l.features.length === 0)).toBe(true);
    const { json } = split(encodeSiteContextGlb(doc));
    const empties: string[] = [];
    const walk = (v: unknown, path: string) => {
      if (Array.isArray(v)) {
        if (v.length === 0 && !path.includes('.extras')) empties.push(path);
        v.forEach((x, i) => walk(x, `${path}[${i}]`));
      } else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
    };
    walk(json, '$');
    expect(empties).toEqual([]);
    expect(decodeSiteContextGlb(encodeSiteContextGlb(doc)).layers.map((l) => l.kind)).toEqual(['terrain', 'parcel']);
  });
});
