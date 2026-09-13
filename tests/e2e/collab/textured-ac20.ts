/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The "textured AC20-FZK-Haus IFCZIP" input of issue #4446, built on the fly.
 *
 * The issue's acceptance used AC20 with an image appearance applied to one
 * member and exported as an IFCZIP. Nothing like it is in the fixture set, so
 * the relay spec builds one here from the plain fixture (`pnpm fixtures`) and
 * commits nothing: one solid interior wall (no openings) keeps its identity,
 * placement chain aside, and gets its Body replaced by the tessellation the
 * repo's own WASM pipeline produces for it — an `IfcTriangulatedFaceSet` in
 * world coordinates under an identity `IfcLocalPlacement` — with an
 * `IfcIndexedTriangleTextureMap` onto a generated 8×8 PNG, the same entity set
 * the Appearance workspace writes for an evaluated body. Everything else in the
 * file is untouched, so the room keeps AC20's entity and geometry counts.
 *
 * The generator re-tessellates its own output and refuses to hand over a file
 * whose wall moved (frame mapping is checked, not assumed).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import type { GeometryProcessor as GeometryProcessorType, MeshData } from '../../../packages/geometry/dist/index.js';

const WALL_GLOBAL_ID = '2XPyKWY018sA1ygZKgQPtU'; // Wand-Int-ERDG-4, no IfcRelVoidsElement
export const TEXTURE_FILE = 'ac20-wall-texture.png';
const TEXTURE_SIZE = 8;

export interface TexturedAc20 {
  ifczipPath: string;
  wallExpressId: number;
  wallGlobalId: string;
  /** Triangles of the textured wall's new tessellated body. */
  wallTriangles: number;
  texture: { width: number; height: number; rgbaFnv1a: string };
}

/** FNV-1a 32-bit over bytes, as 8 hex chars — the same fingerprint the spec computes in-page. */
export function fnv1a(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array, seed = 0xffffffff): number {
  let c = seed;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return c >>> 0;
}

/** Opaque 8×8 RGBA test card: 64 distinct colours, no ancillary chunks (decodes pixel-exact). */
export function testCardRgba(size = TEXTURE_SIZE): Uint8Array {
  const rgba = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      rgba[o] = Math.round((x / (size - 1)) * 255);
      rgba[o + 1] = Math.round((y / (size - 1)) * 255);
      rgba[o + 2] = (x + y) % 2 === 0 ? 40 : 215;
      rgba[o + 3] = 255;
    }
  }
  return rgba;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(Buffer.from(type, 'latin1'), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, (crc32(out.subarray(4, 8 + data.length)) ^ 0xffffffff) >>> 0);
  return out;
}

/** Minimal RGBA8 PNG encoder (IHDR + IDAT + IEND; filter 0 on every row). */
export function encodePng(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit, RGBA, deflate, no filter method, no interlace
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', new Uint8Array(deflateSync(raw))),
    pngChunk('IEND', new Uint8Array(0)),
  ]);
}

/** Minimal STORE-method zip (the parser's IFCZIP reader handles stored entries). */
export function zipStored(entries: ReadonlyArray<{ name: string; data: Uint8Array }>): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = (crc32(data) ^ 0xffffffff) >>> 0;
    const local = new Uint8Array(30 + nameBytes.length);
    const ld = new DataView(local.buffer);
    ld.setUint32(0, 0x04034b50, true);
    ld.setUint16(4, 20, true);
    ld.setUint32(14, crc, true);
    ld.setUint32(18, data.length, true);
    ld.setUint32(22, data.length, true);
    ld.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    const central = new Uint8Array(46 + nameBytes.length);
    const cd = new DataView(central.buffer);
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, data.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    locals.push(local, data);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ed = new DataView(eocd.buffer);
  ed.setUint32(0, 0x06054b50, true);
  ed.setUint16(8, entries.length, true);
  ed.setUint16(10, entries.length, true);
  ed.setUint32(12, cdSize, true);
  ed.setUint32(16, offset, true);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

async function tessellate(bytes: Uint8Array): Promise<MeshData[]> {
  const { GeometryProcessor } = (await import('../../../packages/geometry/dist/index.js')) as {
    GeometryProcessor: new () => GeometryProcessorType;
  };
  const processor = new GeometryProcessor();
  try {
    await processor.init();
    return (await processor.process(bytes)).meshes;
  } finally {
    processor.dispose();
  }
}

/** World-space (renderer Y-up) bounds of every mesh of `expressId`, or null when it has none. */
function worldBounds(meshes: readonly MeshData[], expressId: number): { min: number[]; max: number[] } | null {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let any = false;
  for (const m of meshes) {
    if (m.expressId !== expressId) continue;
    const o = m.origin ?? [0, 0, 0];
    for (let i = 0; i < m.positions.length; i += 3) {
      any = true;
      for (let k = 0; k < 3; k++) {
        const v = o[k] + m.positions[i + k];
        if (v < min[k]) min[k] = v;
        if (v > max[k]) max[k] = v;
      }
    }
  }
  return any ? { min, max } : null;
}

const num = (v: number): string => {
  const s = Number(v.toFixed(6)).toString();
  return s.includes('.') || s.includes('e') ? s : `${s}.`;
};

/** Build the textured IFCZIP into `outDir` and return what the spec asserts on. */
export async function buildTexturedAc20(ac20Path: string, outDir: string): Promise<TexturedAc20> {
  const rgba = testCardRgba();
  const texture = { width: TEXTURE_SIZE, height: TEXTURE_SIZE, rgbaFnv1a: fnv1a(rgba) };
  const source = readFileSync(ac20Path);
  const text = source.toString('latin1');

  const wallMatch = text.match(new RegExp(`^#(\\d+)= IFCWALLSTANDARDCASE\\('${WALL_GLOBAL_ID.replace(/\$/g, '\\$')}',(.*)\\);$`, 'm'));
  if (!wallMatch) throw new Error(`${WALL_GLOBAL_ID} not found in ${ac20Path}`);
  const wallExpressId = Number(wallMatch[1]);
  const bodyContext = text.match(/^#(\d+)= IFCGEOMETRICREPRESENTATIONSUBCONTEXT\('Body','Model'/m)?.[1];
  if (!bodyContext) throw new Error('AC20 has no Body sub-context');

  const ifczipPath = join(outDir, 'AC20-FZK-Haus.textured.ifczip');
  mkdirSync(outDir, { recursive: true });

  const sourceBytes = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  const before = await tessellate(sourceBytes.slice());
  const wallMeshes = before.filter((m) => m.expressId === wallExpressId);
  if (wallMeshes.length === 0) throw new Error(`wall #${wallExpressId} did not tessellate`);
  const expected = worldBounds(before, wallExpressId)!;

  // Renderer frame (Y-up, world = origin + position) → IFC world (Z-up): (x, y, z) ↦ (x, −z, y).
  // A rotation, so triangle winding survives.
  const coords: string[] = [];
  const uvs: string[] = [];
  const tris: string[] = [];
  const ifcPts: number[][] = [];
  let base = 0;
  for (const m of wallMeshes) {
    const o = m.origin ?? [0, 0, 0];
    for (let i = 0; i < m.positions.length; i += 3) {
      ifcPts.push([o[0] + m.positions[i], -(o[2] + m.positions[i + 2]), o[1] + m.positions[i + 1]]);
    }
    for (let i = 0; i < m.indices.length; i += 3) {
      tris.push(`(${base + m.indices[i] + 1},${base + m.indices[i + 1] + 1},${base + m.indices[i + 2] + 1})`);
    }
    base += m.positions.length / 3;
  }
  // Planar UVs over the two longest IFC axes of the wall's box.
  const lo = [0, 1, 2].map((k) => Math.min(...ifcPts.map((p) => p[k])));
  const hi = [0, 1, 2].map((k) => Math.max(...ifcPts.map((p) => p[k])));
  const [ua, va] = [0, 1, 2].sort((a, b) => hi[b] - lo[b] - (hi[a] - lo[a])).slice(0, 2);
  for (const p of ifcPts) {
    coords.push(`(${num(p[0])},${num(p[1])},${num(p[2])})`);
    uvs.push(`(${num((p[ua] - lo[ua]) / (hi[ua] - lo[ua]))},${num((p[va] - lo[va]) / (hi[va] - lo[va]))})`);
  }

  let next = Math.max(...Array.from(text.matchAll(/^#(\d+)=/gm), (m) => Number(m[1]))) + 1;
  const id = () => next++;
  const [ptId, axisId, placementId, listId, faceSetId, imageId, uvListId, mapId, repId, shapeId] = Array.from({ length: 10 }, id);
  const added = [
    `#${ptId}= IFCCARTESIANPOINT((0.,0.,0.));`,
    `#${axisId}= IFCAXIS2PLACEMENT3D(#${ptId},$,$);`,
    `#${placementId}= IFCLOCALPLACEMENT($,#${axisId});`,
    `#${listId}= IFCCARTESIANPOINTLIST3D((${coords.join(',')}));`,
    `#${faceSetId}= IFCTRIANGULATEDFACESET(#${listId},$,$,(${tris.join(',')}),$);`,
    `#${imageId}= IFCIMAGETEXTURE(.T.,.T.,$,$,$,'${TEXTURE_FILE}');`,
    `#${uvListId}= IFCTEXTUREVERTEXLIST((${uvs.join(',')}));`,
    `#${mapId}= IFCINDEXEDTRIANGLETEXTUREMAP((#${imageId}),#${faceSetId},#${uvListId},$);`,
    `#${repId}= IFCSHAPEREPRESENTATION(#${bodyContext},'Body','Tessellation',(#${faceSetId}));`,
    `#${shapeId}= IFCPRODUCTDEFINITIONSHAPE($,$,(#${repId}));`,
  ];
  // After GlobalId: OwnerHistory, Name, Description, ObjectType, ObjectPlacement, Representation, Tag, PredefinedType.
  const attrs = wallMatch[2].split(',');
  if (attrs.length !== 8) throw new Error(`unexpected IFCWALLSTANDARDCASE attribute list: ${wallMatch[0]}`);
  attrs[4] = `#${placementId}`;
  attrs[5] = `#${shapeId}`;
  // Replacer functions: STEP text is full of `$`, which string replacements would interpret.
  const rewritten = text
    .replace(wallMatch[0], () => `#${wallExpressId}= IFCWALLSTANDARDCASE('${WALL_GLOBAL_ID}',${attrs.join(',')});`)
    .replace(/\nENDSEC;\s*\nEND-ISO-10303-21;/, () => `\n${added.join('\n')}\nENDSEC;\n\nEND-ISO-10303-21;`);
  if (rewritten === text) throw new Error('AC20 rewrite did not apply');
  const ifc = Buffer.from(rewritten, 'latin1');

  // Round trip: the same pipeline must place the tessellated wall where the extrusion was.
  const after = await tessellate(new Uint8Array(ifc.buffer, ifc.byteOffset, ifc.byteLength).slice());
  const got = worldBounds(after, wallExpressId);
  if (!got) throw new Error('the tessellated wall did not come back from the geometry pipeline');
  for (let k = 0; k < 3; k++) {
    if (Math.abs(got.min[k] - expected.min[k]) > 1e-3 || Math.abs(got.max[k] - expected.max[k]) > 1e-3) {
      throw new Error(`textured wall moved: expected ${JSON.stringify(expected)} got ${JSON.stringify(got)}`);
    }
  }
  const textured = after.filter((m) => m.expressId === wallExpressId);
  if (!textured.every((m) => m.uvs && m.textureRef)) throw new Error('the pipeline did not attach the texture map to the wall');
  if (after.length !== before.length) throw new Error(`mesh count changed ${before.length} → ${after.length}`);

  writeFileSync(ifczipPath, zipStored([
    { name: 'AC20-FZK-Haus.textured.ifc', data: new Uint8Array(ifc.buffer, ifc.byteOffset, ifc.byteLength) },
    { name: TEXTURE_FILE, data: encodePng(rgba, TEXTURE_SIZE, TEXTURE_SIZE) },
  ]));
  return { ifczipPath, wallExpressId, wallGlobalId: WALL_GLOBAL_ID, wallTriangles: tris.length, texture };
}

/** True when the plain fixture and the built wasm runtime are both present. */
export function texturedAc20Inputs(root: string): { ac20: string; ok: boolean } {
  const ac20 = join(root, 'tests/models/ara3d/AC20-FZK-Haus.ifc');
  return { ac20, ok: existsSync(ac20) && existsSync(join(root, 'packages/wasm/pkg/ifc-lite_bg.wasm')) && existsSync(join(root, 'packages/geometry/dist/index.js')) };
}
