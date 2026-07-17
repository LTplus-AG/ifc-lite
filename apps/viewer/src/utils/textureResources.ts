/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `.ifcZIP` texture-image resolution for the viewer (#1781).
 *
 * An `IfcImageTexture.URLReference` is a relative filename whose image ships
 * as a sibling entry inside the `.ifcZIP`. The parser surfaces those entries
 * as raw bytes (`unwrapIfcZipWithResources`); this module decodes each image
 * ONCE to an `ImageBitmap` (native decoder, off the critical path) and
 * attaches the shared bitmap to every arriving mesh whose `textureRef`
 * resolves to it — the renderer then uploads ONE GPU texture per `textureId`.
 */

import type { MeshData } from '@ifc-lite/geometry';

/** Decoded sibling images keyed by lowercased basename. */
export type TextureBitmapStore = Map<string, ImageBitmap>;

/**
 * Decode every sibling raster image to an `ImageBitmap`. Failures are
 * per-image and non-fatal (a corrupt entry just renders that texture's meshes
 * with their style colour). Returns null when there is nothing to decode so
 * untextured loads pay nothing.
 */
export async function decodeTextureResources(
  resources: Map<string, Uint8Array>,
): Promise<TextureBitmapStore | null> {
  if (resources.size === 0) return null;
  const store: TextureBitmapStore = new Map();
  await Promise.all(
    Array.from(resources, async ([name, bytes]) => {
      try {
        // Copy into a fresh ArrayBuffer-backed blob part: `bytes` may be a
        // view over a larger (or Shared) buffer.
        const copy = new Uint8Array(bytes);
        const bitmap = await createImageBitmap(new Blob([copy]));
        store.set(name, bitmap);
      } catch (err) {
        console.warn(`[textures] Failed to decode .ifcZIP image "${name}"`, err);
      }
    }),
  );
  return store.size > 0 ? store : null;
}

/**
 * Normalize an `IfcImageTexture.URLReference` to the sibling-store key:
 * strip any URI scheme/path, URL-decode, lowercase — so `Textures/Wood.JPG`,
 * `./wood.jpg` and `file:///x/wood.jpg` all resolve a `wood.jpg` entry.
 */
export function textureUrlBasename(url: string): string {
  let name = url.trim().replace(/\\/g, '/');
  const slash = name.lastIndexOf('/');
  if (slash >= 0) name = name.slice(slash + 1);
  try {
    name = decodeURIComponent(name);
  } catch {
    // Malformed percent-encoding: match on the raw spelling.
  }
  return name.toLowerCase();
}

/**
 * Attach the decoded `ImageBitmap` to every mesh whose `textureRef` resolves
 * against the store. Mutates the meshes in place (the same objects flow to
 * the renderer AND into `geometryResult.meshes`). Unresolved refs are left
 * bitmap-less and render as ordinary flat-colour geometry.
 */
export function attachTextureBitmaps(
  meshes: MeshData[],
  store: TextureBitmapStore | null,
): void {
  if (!store) return;
  for (const mesh of meshes) {
    if (!mesh.textureRef || mesh.textureBitmap) continue;
    const bitmap = store.get(textureUrlBasename(mesh.textureRef.url));
    if (bitmap) mesh.textureBitmap = bitmap;
  }
}
