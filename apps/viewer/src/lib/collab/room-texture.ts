/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MeshData, MeshTexture } from '@ifc-lite/geometry';
import type { BlobStore } from '@ifc-lite/collab';
import { decodeMesh, type RoomTextureRef } from './mesh-codec';
import { putBlobWithRetry } from './blob-upload';

// A single decoded image is bounded independently of mesh size. Keep below
// the room blob endpoint's default 100 MiB limit, including our 12-byte header.
// The viewer requests a core adapter and raises buffer limits only; its
// maxTextureDimension2D remains the WebGPU core default of 8192.
const MAX_DIMENSION = 8192;
const MAX_PIXELS = 4096 * 4096;
const MAGIC = 0x54584649; // IFXT, top-down RGBA8, straight alpha, sRGB.

/** Static, user-actionable source failures safe to show in the Share dialog. */
export class TextureSharingError extends Error {}

function pixelBytes(width: number, height: number): number {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) {
    throw new TextureSharingError('Texture dimensions must fit 8192 pixels per side and 16,777,216 pixels total. Resize the source image, reload the IFCZIP, and share again.');
  }
  return width * height * 4;
}

export function encodeTexture(texture: Pick<MeshTexture, 'width' | 'height' | 'rgba'>): Uint8Array {
  const count = pixelBytes(texture.width, texture.height);
  if (texture.rgba.length !== count) throw new Error('room-texture: RGBA length does not match dimensions');
  const bytes = new Uint8Array(12 + count);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, texture.width, true);
  view.setUint32(8, texture.height, true);
  bytes.set(texture.rgba, 12);
  return bytes;
}

export function decodeTexture(bytes: Uint8Array): Pick<MeshTexture, 'width' | 'height' | 'rgba'> {
  if (bytes.length < 12) throw new Error('room-texture: truncated header');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC) throw new Error('room-texture: bad magic');
  const width = view.getUint32(4, true), height = view.getUint32(8, true);
  if (bytes.length !== 12 + pixelBytes(width, height)) throw new Error('room-texture: invalid pixel payload');
  return { width, height, rgba: bytes.slice(12) };
}

function bitmapPixels(bitmap: ImageBitmap): Pick<MeshTexture, 'width' | 'height' | 'rgba'> {
  const { width, height } = bitmap;
  pixelBytes(width, height);
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('room-texture: cannot read texture pixels for sharing');
  context.drawImage(bitmap, 0, 0);
  const pixels = context.getImageData(0, 0, width, height).data;
  return { width, height, rgba: new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength) };
}

/** Per-seed cache uses image identity, so overlapping federated texture ids cannot collide. */
export function textureUploader(store: BlobStore, retries: number, delays: readonly number[]) {
  const uploads = new WeakMap<object, Promise<string>>();
  return async (mesh: MeshData): Promise<RoomTextureRef | undefined> => {
    const image = mesh.texture ?? mesh.textureBitmap;
    if (!image) {
      if (mesh.textureRef) throw new Error('room-texture: source image is unavailable; reload the original IFCZIP before sharing');
      return undefined;
    }
    const sampler = mesh.texture ?? mesh.textureRef;
    if (!sampler || mesh.uvs?.length !== mesh.positions.length / 3 * 2) throw new Error('room-texture: textured mesh has no valid UVs or sampler');
    let upload = uploads.get(image);
    if (!upload) {
      upload = Promise.resolve().then(async () => {
        const pixels = mesh.texture ?? bitmapPixels(mesh.textureBitmap!);
        return (await putBlobWithRetry(store, encodeTexture(pixels), retries, delays)).hash;
      });
      uploads.set(image, upload);
    }
    return { hash: await upload, repeatS: sampler.repeatS, repeatT: sampler.repeatT };
  };
}

async function fetchTexture(store: BlobStore, hash: string): Promise<ReturnType<typeof decodeTexture>> {
  // A recipient may see a geometry update before a replicated image becomes
  // readable. Retry inside this hydrate: the room observer only reruns when
  // geometry changes, so merely leaving its cache empty is not sufficient.
  for (let attempt = 0; attempt < 3; attempt++) {
    let bytes: Uint8Array | null = null;
    try {
      bytes = await store.get(hash);
    } catch (error) {
      if (attempt === 2) throw error;
    }
    if (bytes) return decodeTexture(bytes); // corrupt payloads are not retried
    if (attempt === 2) throw new Error('room-texture: image unavailable after 3 attempts; reconnect to retry');
    await new Promise(resolve => setTimeout(resolve, attempt === 0 ? 150 : 600));
  }
  throw new Error('room-texture: exhausted image attempts');
}

// Blob stores are session-owned. Weak keys release decoded images on room
// teardown, while live re-hydrates keep one pixel identity for GPU sharing.
const sessionImages = new WeakMap<BlobStore, Map<string, Promise<ReturnType<typeof decodeTexture>>>>();

/** Share decoded pixels across geometry batches and subsequent room updates. */
export function texturedMeshDecoder(store: BlobStore) {
  let images = sessionImages.get(store);
  if (!images) { images = new Map(); sessionImages.set(store, images); }
  const cache = images;
  return async (bytes: Uint8Array): Promise<MeshData> => {
    const { roomTexture, ...mesh } = decodeMesh(bytes);
    if (!roomTexture) return mesh;
    let image = cache.get(roomTexture.hash);
    if (!image) {
      image = fetchTexture(store, roomTexture.hash).catch(error => {
        cache.delete(roomTexture.hash); // a failed replica must be retryable
        throw error;
      });
      cache.set(roomTexture.hash, image);
    }
    mesh.texture = { ...await image, repeatS: roomTexture.repeatS, repeatT: roomTexture.repeatT };
    return mesh;
  };
}
