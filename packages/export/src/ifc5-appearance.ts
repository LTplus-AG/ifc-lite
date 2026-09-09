/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MeshData } from '@ifc-lite/geometry';
import { encodeIfcxImage, IFCX_APPEARANCE, IFCX_IMAGE, type IfcxNode, type IfcxPixels, type IfcxEncodedImage } from '@ifc-lite/ifcx';

/** Packs canonical mesh fragments without evaluating styles or changing UV mappings. */
export class Ifc5AppearanceWriter {
  readonly images: IfcxNode[] = [];
  private readonly imagePaths = new Map<string, string>();
  private readonly sourcePaths = new WeakMap<object, Map<string, string>>();
  private imageBytes = 0;
  private nextFragment = 0;

  constructor(private readonly occupiedPaths: Set<string>, private readonly originals?: ReadonlyMap<string, IfcxEncodedImage>) {}

  private uniquePath(proposed: string): string {
    let path = proposed;
    for (let suffix = 1; this.occupiedPaths.has(path); suffix++) path = `${proposed}-${suffix}`;
    this.occupiedPaths.add(path);
    return path;
  }

  private image(mesh: MeshData): string {
    const source = mesh.texture?.rgba ?? mesh.textureBitmap;
    if (!source) throw new Error('Cannot export an unresolved IFCX texture. Load its image before exporting.');
    const dimensions = mesh.texture ?? mesh.textureBitmap!;
    const dimensionKey = `${dimensions.width}x${dimensions.height}`;
    const original = (mesh.textureRef ? this.originals?.get(mesh.textureRef.url) : undefined)
      ?? (mesh.texture as IfcxPixels | undefined)?.original;
    const cached = !original && this.sourcePaths.get(source)?.get(dimensionKey);
    if (cached) return cached;
    let pixels: IfcxPixels;
    if (mesh.texture) {
      pixels = mesh.texture;
    } else {
      const bitmap = mesh.textureBitmap!;
      if (typeof OffscreenCanvas === 'undefined') {
        throw new Error('IFCX bitmap export requires OffscreenCanvas; headless callers can supply decoded MeshData.texture pixels.');
      }
      if (bitmap.width < 1 || bitmap.height < 1 || bitmap.width > 16_384 || bitmap.height > 16_384
        || bitmap.width * bitmap.height * 4 > 512 * 1024 * 1024) throw new Error('IFCX texture exceeds the image budget.');
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Unable to read the IFCX texture bitmap.');
      context.drawImage(bitmap, 0, 0);
      const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
      pixels = { width: bitmap.width, height: bitmap.height,
        rgba: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), repeatS: false, repeatT: false };
    }
    if (original) pixels = { ...pixels, original };
    const encoded = encodeIfcxImage(pixels);
    let path = this.imagePaths.get(encoded.key);
    if (!path) {
      if (this.imageBytes + (pixels.rgba.length + (pixels.original?.bytes.length ?? 0)) > 512 * 1024 * 1024) throw new Error('IFCX images exceed the 512 MiB file pixel budget.');
      this.imageBytes += pixels.rgba.length + (pixels.original?.bytes.length ?? 0);
      path = this.uniquePath(`ifclite-image-${encoded.key}`);
      this.imagePaths.set(encoded.key, path);
      this.images.push({ path, attributes: { [IFCX_IMAGE]: encoded.value } });
    }
    let sourcePaths = this.sourcePaths.get(source);
    if (!sourcePaths) this.sourcePaths.set(source, sourcePaths = new Map());
    if (!original) sourcePaths.set(dimensionKey, path);
    return path;
  }

  fragments(
    owner: IfcxNode,
    meshes: MeshData[],
    convert: (mesh: MeshData) => { points: number[][]; faceVertexIndices: number[] },
  ): IfcxNode[] {
    const children = owner.children ??= {};
    return meshes.map((mesh, index) => {
      const path = this.uniquePath(`ifclite-mesh-${this.nextFragment++}`);
      let name = `Appearance ${index + 1}`;
      while (Object.hasOwn(children, name)) name += '_';
      children[name] = path;
      const [r, g, b, a] = mesh.color;
      const attributes: Record<string, unknown> = {
        'usd::usdgeom::mesh': convert(mesh),
        'bsi::ifc::presentation::diffuseColor': [r, g, b],
        'bsi::ifc::presentation::opacity': a,
      };
      const sampler = mesh.texture ?? mesh.textureRef;
      if (sampler) {
        if (typeof sampler.repeatS !== 'boolean' || typeof sampler.repeatT !== 'boolean') throw new Error('IFCX texture sampler wraps must be boolean.');
        if (!mesh.uvs || mesh.uvs.length !== mesh.positions.length / 3 * 2
          || !mesh.uvs.every(Number.isFinite)) throw new Error('Cannot export IFCX texture without a finite UV pair per vertex.');
        attributes[IFCX_APPEARANCE] = {
          image: { ref: this.image(mesh) }, uvs: Array.from(mesh.uvs),
          repeatS: sampler.repeatS, repeatT: sampler.repeatT,
        };
      }
      return { path, attributes };
    });
  }
}
