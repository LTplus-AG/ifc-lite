/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { Ray } from './raycaster.js';
import type { PickOptions } from './types.js';
import type { ReferenceImages, ReferenceImageInput, ReferenceImageHit } from './reference-image-types.js';
import { ReferenceImagePipeline, type ReferenceGpuImage } from './reference-image-pipeline.js';
import { referenceImageHit } from './reference-image-hit.js';

export interface ReferenceImageHost {
  requestRender(): void;
  ray(x: number, y: number): Ray | null;
  sceneDistance(x: number, y: number, ray: Ray, options?: PickOptions): Promise<number>;
}

/** String-identity resources separate from all IFC geometry and selection buckets. */
export class ReferenceImageManager implements ReferenceImages {
  private images = new Map<string, ReferenceGpuImage>();
  private jobs = new Map<string, symbol>();
  private pipeline: ReferenceImagePipeline | null = null;
  private device: GPUDevice | null = null;
  private format: GPUTextureFormat = 'bgra8unorm';
  private sampleCount = 1;
  constructor(private host: ReferenceImageHost) {}

  init(device: GPUDevice, format: GPUTextureFormat, sampleCount: number): void {
    this.destroy();
    this.device = device;
    this.format = format;
    this.sampleCount = sampleCount;
  }
  async set(input: ReferenceImageInput, signal?: AbortSignal): Promise<void> {
    const device = this.device;
    if (!device) throw new Error('The renderer is not ready for reference images.');
    if (signal?.aborted) return;
    const current = this.images.get(input.id)?.input;
    if (current?.bitmap === input.bitmap && current.visible === input.visible && current.locked === input.locked && current.opacity === input.opacity &&
      current.corners.every((point, i) => point.every((n, axis) => n === input.corners[i][axis]))) {
      // Also invalidate an older in-flight replacement of this unchanged image.
      this.jobs.delete(input.id);
      return;
    }
    // Snapshot caller geometry: changing a draft must never mutate an in-flight upload.
    const captured: ReferenceImageInput = { ...input, corners: [
      [...input.corners[0]], [...input.corners[1]], [...input.corners[2]], [...input.corners[3]],
    ] };
    const job = Symbol(input.id);
    this.jobs.set(input.id, job);
    device.pushErrorScope('out-of-memory');
    device.pushErrorScope('validation');
    let candidate: ReferenceGpuImage | undefined;
    let failure: unknown;
    try {
      // Ordinary IFC viewing creates no reference shader/pipeline or texture.
      this.pipeline ??= new ReferenceImagePipeline(device, this.format, this.sampleCount);
      candidate = this.pipeline.upload(captured);
    }
    catch (error) { failure = error; }
    // Pop both scopes before awaiting: concurrent set calls must never consume
    // one another's device-global scope stack.
    const validationResult = device.popErrorScope(), memoryResult = device.popErrorScope();
    try {
      const [validation, memory] = await Promise.all([validationResult, memoryResult]);
      if (validation || memory) failure ??= new Error(`Reference image upload failed: ${(validation ?? memory)!.message}`);
    } catch (error) { failure ??= error; }
    if (failure || signal?.aborted || this.jobs.get(input.id) !== job || this.device !== device) {
      candidate?.destroy();
      if (failure && this.device === device) this.pipeline = null;
      if (this.jobs.get(input.id) === job) this.jobs.delete(input.id);
      if (failure) throw failure;
      return;
    }
    this.jobs.delete(input.id);
    if (!candidate) throw new Error('Reference image upload produced no resource.');
    this.images.get(input.id)?.destroy();
    this.images.set(input.id, candidate);
    this.host.requestRender();
  }
  remove(id: string): void {
    this.jobs.delete(id);
    this.images.get(id)?.destroy();
    this.images.delete(id);
    this.host.requestRender();
  }
  clear(): void {
    this.jobs.clear();
    for (const image of this.images.values()) image.destroy();
    this.images.clear();
    this.host.requestRender();
  }
  destroy(): void { this.clear(); this.pipeline = null; this.device = null; }
  draw(pass: GPURenderPassEncoder, viewProj: Float32Array): void {
    if (!this.images.size) return;
    const depth = (image: ReferenceGpuImage): number => {
      const c = image.input.corners;
      const x = (c[0][0]+c[2][0])/2, y = (c[0][1]+c[2][1])/2, z = (c[0][2]+c[2][2])/2;
      return (viewProj[2]*x+viewProj[6]*y+viewProj[10]*z+viewProj[14]) /
        (viewProj[3]*x+viewProj[7]*y+viewProj[11]*z+viewProj[15]);
    };
    // Reverse-Z, far to near for translucent references; BIM depth still tests
    // each fragment. Intersecting transparent planes have ordinary alpha-sort limits.
    for (const image of [...this.images.values()].sort((a, b) => depth(a)-depth(b))) image.draw(pass, viewProj);
  }
  async pick(x: number, y: number, options?: PickOptions): Promise<ReferenceImageHit | null> {
    if (!this.images.size) return null;
    const ray = this.host.ray(x, y);
    if (!ray) return null;
    const snapshot = new Map([...this.images].filter(([, image]) => image.input.visible && !image.input.locked && image.input.opacity > 0 &&
      referenceImageHit(image.input.id, image.input.corners, ray, Infinity) !== null));
    if (!snapshot.size) return null;
    let distance = await this.host.sceneDistance(x, y, ray, options), nearest: ReferenceImageHit | null = null;
    for (const image of snapshot.values()) {
      const { input } = image;
      if (this.images.get(input.id) !== image) continue;
      if (!input.visible || input.locked || input.opacity === 0) continue;
      const hit = referenceImageHit(input.id, input.corners, ray, distance);
      if (hit) { nearest = hit; distance = hit.distance; }
    }
    return nearest;
  }
}
