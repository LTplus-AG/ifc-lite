/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MeshData } from '@ifc-lite/geometry';
import type { GLTFDocument, GLTFPrimitive } from './glb-types.js';
import { readAccessorData } from './glb-accessor.js';

function imagePath(index: number, mime: string): string {
  return `textures/glb-image-${index}.${mime === 'image/png' ? 'png' : 'jpg'}`;
}

/** Encoded embedded base-colour images. Browser decoding belongs to the host. */
function imageResources(gltf: GLTFDocument, bin: Uint8Array, copy: boolean): Map<string, Uint8Array> {
  const resources = new Map<string, Uint8Array>();
  let total = 0;
  for (const material of gltf.materials ?? []) {
    const reference = material.pbrMetallicRoughness?.baseColorTexture;
    if (!reference) continue;
    const index = gltf.textures?.[reference.index]?.source;
    const image = index === undefined ? undefined : gltf.images?.[index];
    if (!image || index === undefined || image.bufferView === undefined || image.uri !== undefined) {
      throw new Error('GLB: base-colour textures require embedded PNG/JPEG buffer views');
    }
    if (image.mimeType !== 'image/png' && image.mimeType !== 'image/jpeg') throw new Error('GLB: unsupported image MIME type');
    const path = imagePath(index, image.mimeType);
    if (resources.has(path)) continue;
    const view = gltf.bufferViews?.[image.bufferView];
    const start = view?.byteOffset ?? 0, length = view?.byteLength;
    if (!view || view.buffer !== 0 || length === undefined || !Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length <= 0 || start + length > bin.byteLength) {
      throw new Error('GLB: image buffer view exceeds the embedded buffer');
    }
    // The host can skip alpha readback for JPEG paths only when the encoded
    // payload really is JPEG. Do not derive that guarantee from untrusted MIME.
    const signature = image.mimeType === 'image/png' ? [137,80,78,71,13,10,26,10] : [255,216,255];
    if (length < signature.length || signature.some((value, offset) => bin[start + offset] !== value)) {
      throw new Error('GLB: image signature does not match its declared MIME type');
    }
    total += length;
    if (resources.size >= 256 || total > 256 * 1024 * 1024) throw new Error('GLB: embedded images exceed the 256-image / 256 MiB limit');
    resources.set(path, copy ? bin.slice(start, start + length) : bin.subarray(start, start + length));
  }
  return resources;
}

export function primitiveTexture(gltf: GLTFDocument, bin: Uint8Array, primitive: GLTFPrimitive, vertexCount: number): Pick<MeshData, 'uvs' | 'textureRef'> {
  const material = primitive.material === undefined ? undefined : gltf.materials?.[primitive.material];
  if (primitive.material !== undefined && !material) throw new Error('GLB: material index does not exist');
  const reference = material?.pbrMetallicRoughness?.baseColorTexture;
  if (!reference) {
    if (primitive.attributes.COLOR_0 !== undefined) {
      throw new Error('GLB: vertex-colour-only appearance is unavailable; export a base-colour texture.');
    }
    return {};
  }
  const transform = reference.extensions?.KHR_texture_transform;
  const texCoord = transform?.texCoord ?? reference.texCoord ?? 0;
  if (!Number.isSafeInteger(texCoord) || texCoord < 0) throw new Error('GLB: invalid base-colour texture coordinate set');
  const attribute = `TEXCOORD_${texCoord}`;
  const accessor = primitive.attributes[attribute];
  if (accessor === undefined || gltf.accessors?.[accessor]?.type !== 'VEC2') throw new Error(`GLB: textured primitive requires ${attribute} VEC2`);
  const raw = readAccessorData(gltf, bin, accessor);
  const declaration = gltf.accessors![accessor];
  const divisor = raw instanceof Float32Array ? 1 : declaration.normalized && raw instanceof Uint16Array ? 65535 : declaration.normalized && raw instanceof Uint8Array ? 255 : 0;
  if (!divisor || raw.length !== vertexCount * 2) throw new Error('GLB: texture coordinates must match every vertex and use float or normalized unsigned components');
  const offset = transform?.offset ?? [0, 0], scale = transform?.scale ?? [1, 1], rotation = transform?.rotation ?? 0;
  if (offset.length !== 2 || scale.length !== 2 || ![...offset, ...scale, rotation].every(Number.isFinite)) throw new Error('GLB: invalid texture transform');
  const uvs = new Float32Array(raw.length), c = Math.cos(rotation), s = Math.sin(rotation);
  for (let i = 0; i < raw.length; i += 2) {
    const u = raw[i] / divisor * scale[0], v = raw[i + 1] / divisor * scale[1];
    uvs[i] = offset[0] + c * u - s * v;
    uvs[i + 1] = offset[1] + s * u + c * v;
    if (!Number.isFinite(uvs[i]) || !Number.isFinite(uvs[i + 1])) throw new Error('GLB: non-finite texture coordinates');
  }
  const texture = gltf.textures?.[reference.index], image = texture?.source === undefined ? undefined : gltf.images?.[texture.source];
  if (!texture || texture.source === undefined || !image?.mimeType) throw new Error('GLB: texture image does not exist');
  const sampler = texture.sampler === undefined ? undefined : gltf.samplers?.[texture.sampler];
  if (texture.sampler !== undefined && !sampler) throw new Error('GLB: sampler does not exist');
  const wrap = (value = 10497) => {
    if (value !== 10497 && value !== 33071) throw new Error('GLB: mirrored texture repeat is not supported');
    return value === 10497;
  };
  return { uvs, textureRef: { textureId: reference.index + 1, url: imagePath(texture.source, image.mimeType), repeatS: wrap(sampler?.wrapS), repeatT: wrap(sampler?.wrapT) } };
}

export function parseGLBImageResources(gltf: GLTFDocument, bin: Uint8Array): Map<string, Uint8Array> { return imageResources(gltf, bin, true); }
export function validateGLBImages(gltf: GLTFDocument, bin: Uint8Array): void { imageResources(gltf, bin, false); }
