/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Render-target VRAM the renderer currently holds, by owner.
 *
 * `sumResidentGpuBytes` (render-stats.ts) counts geometry. A small model's GPU
 * footprint is dominated instead by screen-sized attachments: the 4x MSAA
 * colour, object-id and depth surfaces, the picker's id/depth pair, and the
 * post-pass targets. This sums them from the textures' own descriptors
 * (`width x height x layers x sampleCount x bytes per texel`), so allocating
 * lazily or freeing a target shows up here. It is a lower bound: drivers pad,
 * compress and may store `depth24plus-stencil8` in more than four bytes, and
 * the canvas swap chain is not ours to count.
 */

/** Structural slice of a `GPUTexture` (a real one satisfies it). */
export interface TextureLike {
  width: number;
  height: number;
  depthOrArrayLayers: number;
  sampleCount: number;
  format: GPUTextureFormat;
}

/** Bytes per texel for every attachment format the renderer allocates. */
const BYTES_PER_TEXEL: Partial<Record<GPUTextureFormat, number>> = {
  r8unorm: 1,
  rg8unorm: 2,
  rg16float: 4,
  r32uint: 4,
  r32float: 4,
  rgba8unorm: 4,
  'rgba8unorm-srgb': 4,
  bgra8unorm: 4,
  'bgra8unorm-srgb': 4,
  rgba16float: 8,
  depth16unorm: 2,
  depth24plus: 4,
  'depth24plus-stencil8': 4,
  depth32float: 4,
  'depth32float-stencil8': 5,
};

/** Allocation estimate for one texture; unknown formats count 4 B/texel. */
export function textureBytes(texture: TextureLike): number {
  const perTexel = BYTES_PER_TEXEL[texture.format] ?? 4;
  return texture.width * texture.height * texture.depthOrArrayLayers * texture.sampleCount * perTexel;
}

export function sumTextureBytes(textures: Iterable<TextureLike | null | undefined> | undefined): number {
  let bytes = 0;
  for (const texture of textures ?? []) if (texture) bytes += textureBytes(texture);
  return bytes;
}

/** Render-target bytes by owner. All values in bytes. */
export interface RenderTargetBytes {
  /** Main pass: MSAA colour, object id, depth, plus the orthographic geometric depth while allocated. */
  main: number;
  /** GPU picker id + depth targets (allocated on the first GPU pick). */
  picker: number;
  /** Post passes: ambient occlusion and the selection/hover outline masks. */
  post: number;
  /** Sun shadow map, while shadows are on. */
  shadow: number;
  total: number;
}

export function renderTargetBytes(owners: {
  main?: Iterable<TextureLike | null>;
  picker?: Iterable<TextureLike | null>;
  post?: Iterable<TextureLike | null>;
  /** Square depth32float shadow map edge in texels, or null while shadows are off. */
  shadowResolution?: number | null;
}): RenderTargetBytes {
  const main = sumTextureBytes(owners.main);
  const picker = sumTextureBytes(owners.picker);
  const post = sumTextureBytes(owners.post);
  const edge = owners.shadowResolution ?? 0;
  const shadow = edge * edge * 4;
  return { main, picker, post, shadow, total: main + picker + post + shadow };
}
