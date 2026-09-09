/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MeshTexture } from '@ifc-lite/geometry';

type Entry = { texture: GPUTexture; width: number; height: number; refs: number };

/** Room recipients share decoded pixel arrays across surfaces (#4228, #4232).
 * Keep that sharing on the GPU too; sampler settings belong to each draw. */
export class RgbaTexturePool {
  // GPU ownership must not keep released CPU pixel arrays alive.
  private entries = new WeakMap<Uint8Array, Entry[]>();
  private owners = new Map<GPUTexture, { siblings: Entry[]; entry: Entry }>();

  acquire(source: MeshTexture, device: GPUDevice): GPUTexture {
    const { rgba, width, height } = source;
    const entries = this.entries.get(rgba) ?? [];
    let entry = entries.find(value => value.width === width && value.height === height);
    if (!entry) {
      const texture = device.createTexture({
        size: { width, height }, format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      try {
        device.queue.writeTexture({ texture }, rgba,
          { bytesPerRow: width * 4, rowsPerImage: height }, { width, height });
      } catch (error) {
        texture.destroy();
        throw error;
      }
      entry = { texture, width, height, refs: 0 };
      entries.push(entry);
      this.entries.set(rgba, entries);
      this.owners.set(texture, { siblings: entries, entry });
    }
    entry.refs++;
    return entry.texture;
  }

  /** Return false only for textures owned by another allocation path. */
  release(texture: GPUTexture): boolean {
    const owner = this.owners.get(texture);
    if (!owner) return false;
    if (--owner.entry.refs === 0) {
      const siblings = owner.siblings;
      siblings.splice(siblings.indexOf(owner.entry), 1);
      this.owners.delete(texture);
      texture.destroy();
    }
    return true;
  }

  clear(): void {
    for (const texture of this.owners.keys()) texture.destroy();
    this.owners.clear();
    this.entries = new WeakMap();
  }
}
