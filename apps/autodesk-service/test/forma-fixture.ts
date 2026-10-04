/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/** Binary glTF triangle with known placement, color and name-selection contract. */
export function triangle(): Uint8Array {
  const document = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, translation: [0, 2, 0] }],
    meshes: [{ name: 'part', primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    materials: [{ alphaMode: 'BLEND', pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 0.5] } }],
    buffers: [{ byteLength: 36 }], bufferViews: [{ buffer: 0, byteLength: 36 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }] };
  const json = Buffer.from(JSON.stringify(document)); const padded = (json.length + 3) & ~3;
  const bytes = Buffer.alloc(12 + 8 + padded + 8 + 36, 32);
  [0x46546c67, 2, bytes.length, padded, 0x4e4f534a].forEach((v, i) => bytes.writeUInt32LE(v, i * 4));
  json.copy(bytes, 20); const offset = 20 + padded;
  bytes.writeUInt32LE(36, offset); bytes.writeUInt32LE(0x004e4942, offset + 4);
  [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((v, i) => bytes.writeFloatLE(v, offset + 8 + i * 4));
  return bytes;
}
