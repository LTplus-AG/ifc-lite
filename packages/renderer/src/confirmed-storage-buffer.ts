/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A storage buffer holding one u32 image, grown only once WebGPU has
 * confirmed the larger allocation (#10636). The hide/isolate table
 * (`entity-visibility-table.ts`) and the highlighted-entity table
 * (`entity-highlight-table.ts`) both live in the shared entity group
 * (`section-exclusions.ts`) and grow this way.
 *
 * `createBuffer` does not throw on out-of-memory: it returns an invalid
 * buffer and reports through an error scope, later. Binding that buffer
 * would invalidate the whole group for every draw and pick, so the validated
 * buffer stays bound until the replacement's scopes settle clean. One attempt
 * per pending growth, none for an image already rejected; a different image
 * may try again, and a smaller one that fits the bound buffer is written at
 * once.
 */
export class ConfirmedStorageBuffer {
  buffer: GPUBuffer;
  private bytes: number;
  private image: Uint32Array | null = null;
  private growth: Promise<boolean> | null = null;
  /** The image whose growth WebGPU rejected: not retried, so sustained OOM cannot loop. */
  private failed: Uint32Array | null = null;

  /**
   * @param limit Largest binding the device allows, a multiple of 4 bytes.
   * @param onGrown Called once a larger buffer replaced `buffer`, to rebind it.
   * @param released Whether the owner let go meanwhile: a late candidate is then destroyed, not bound.
   */
  constructor(
    private readonly device: GPUDevice,
    private readonly label: string,
    initialBytes: number,
    private readonly limit: number,
    private readonly onGrown: () => void,
    private readonly released: () => boolean,
  ) {
    this.bytes = Math.min(initialBytes, limit);
    this.buffer = this.allocate(this.bytes); // zeroed: the empty image of either table
  }

  private allocate(size: number): GPUBuffer {
    return this.device.createBuffer({ label: this.label, size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  }

  /**
   * Make `image` what the next submission reads. An image already written is
   * not uploaded again. False, leaving the bound buffer unchanged, when the
   * image cannot be held: over the device limit, or larger than the current
   * buffer while its replacement is unconfirmed or was rejected. The caller
   * must then not draw anything that relies on the table.
   */
  write(image: Uint32Array): boolean {
    if (image.byteLength > this.limit) return false;
    if (image.byteLength > this.bytes) { this.grow(image); return false; }
    if (image !== this.image) {
      this.device.queue.writeBuffer(this.buffer, 0, image);
      this.image = image;
    }
    return true;
  }

  /** Settles true once a larger buffer is bound, false when WebGPU rejected it; null when none is pending. */
  get pending(): Promise<boolean> | null { return this.growth; }

  destroy(): void { this.buffer.destroy(); }

  private grow(image: Uint32Array): void {
    if (this.growth || image === this.failed
      || (image.length === this.failed?.length && image.every((word, i) => word === this.failed![i]))) return;
    const device = this.device;
    let size = Math.max(16, this.bytes);
    while (size < image.byteLength) size *= 2; // geometric, so a growing set reallocates rarely
    size = Math.min(size, this.limit);
    device.pushErrorScope('out-of-memory');
    device.pushErrorScope('validation');
    let candidate: GPUBuffer | null = null;
    try { candidate = this.allocate(size); }
    catch (error) { console.warn(`[SectionExclusions] ${this.label} allocation threw:`, error); }
    // Pop both before awaiting so no other caller's scope is consumed.
    const scopes = Promise.all([device.popErrorScope(), device.popErrorScope()]);
    this.growth = scopes.then(([validation, memory]) => {
      const error = validation ?? memory;
      if (error) console.warn(`[SectionExclusions] ${this.label} table growth rejected; draws that need it stay out:`, error.message);
      return candidate !== null && !error;
    }, error => { console.warn(`[SectionExclusions] could not confirm ${this.label} allocation:`, error); return false; }).then(valid => {
      this.growth = null;
      if (!valid || this.released()) {
        candidate?.destroy();
        if (!valid) this.failed = image;
        return false;
      }
      this.buffer.destroy();
      this.buffer = candidate!; this.bytes = size;
      this.image = null; // the new buffer is zeroed: write the current image on next use
      this.failed = null;
      this.onGrown();
      return true;
    });
  }
}
