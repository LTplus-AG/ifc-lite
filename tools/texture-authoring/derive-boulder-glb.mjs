/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Offline fixture preparation, not a production import path. Inputs are the
// original CC0 Poly Haven boulder_01 glTF, BIN and diffuse JPEG downloads.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const [folder, output] = process.argv.slice(2);
if (!folder || !output) throw new Error('Usage: node tools/texture-authoring/derive-boulder-glb.mjs <download-folder> <output.glb>');
const json = JSON.parse(await readFile(join(folder, 'boulder_01_1k.gltf'), 'utf8'));
const geometry = await readFile(join(folder, 'boulder_01.bin'));
const image = await readFile(join(folder, 'textures/boulder_01_diff_1k.jpg'));
// F5 creates captured albedo surfaces. Explicitly derive an ALBEDO-ONLY fixture:
// discard normal/metallic-roughness maps; do not imply full PBR import support.
json.materials = [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1 } }];
json.textures = [{ source: 0, sampler: 0 }];
json.images = [{ mimeType: 'image/jpeg', bufferView: json.bufferViews.length }];
json.bufferViews.push({ buffer: 0, byteOffset: geometry.length, byteLength: image.length });
const data = Buffer.concat([geometry, image]);
json.buffers = [{ byteLength: data.length }];
const jsonText = Buffer.from(JSON.stringify(json));
const text = Buffer.alloc(Math.ceil(jsonText.length / 4) * 4, 32); jsonText.copy(text);
const bin = Buffer.alloc(Math.ceil(data.length / 4) * 4); data.copy(bin);
const header = Buffer.alloc(12); header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(28 + text.length + bin.length, 8);
const chunk = (bytes, kind) => { const h = Buffer.alloc(8); h.writeUInt32LE(bytes.length, 0); h.writeUInt32LE(kind, 4); return Buffer.concat([h, bytes]); };
const glb = Buffer.concat([header, chunk(text, 0x4e4f534a), chunk(bin, 0x004e4942)]);
await writeFile(output, glb);
console.log(JSON.stringify({ output, bytes: glb.length, sha256: createHash('sha256').update(glb).digest('hex'), imageSha256: createHash('sha256').update(image).digest('hex'), vertices: json.accessors[0].count, triangles: json.accessors[3].count / 3, derivation: 'Albedo-only; original geometry, UVs, indices and diffuse JPEG bytes unchanged' }, null, 2));
