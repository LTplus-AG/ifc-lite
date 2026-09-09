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
  constructor(private host: ReferenceImageHost) {}

  init(device: GPUDevice, format: GPUTextureFormat, sampleCount: number): void {
    this.destroy();
    this.device = device;
    this.pipeline = new ReferenceImagePipeline(device, format, sampleCount);
  }
  async set(input: ReferenceImageInput, signal?: AbortSignal): Promise<void> {
    const device = this.device, pipeline = this.pipeline;
    if (!device || !pipeline) throw new Error('The renderer is not ready for reference images.');
    if (signal?.aborted) return;
    // Snapshot caller geometry: changing a draft must never mutate an in-flight upload.
    const captured: ReferenceImageInput = { ...input, corners: [
      [...input.corners[0]], [...input.corners[1]], [...input.corners[2]], [...input.corners[3]],
    ] };
    const job = Symbol(input.id);
    this.jobs.set(input.id, job);
    device.pushErrorScope('validation');
    let candidate: ReferenceGpuImage | undefined;
    let failure: unknown;
    try { candidate = pipeline.upload(captured); }
    catch (error) { failure = error; }
    try {
      const validation = await device.popErrorScope();
      if (validation) failure ??= new Error(`Reference image upload failed: ${validation.message}`);
    } catch (error) { failure ??= error; }
    if (failure || signal?.aborted || this.jobs.get(input.id) !== job || this.device !== device) {
      candidate?.destroy();
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
    const ray = this.host.ray(x, y);
    if (!ray) return null;
    const snapshot = new Map(this.images);
    let distance = await this.host.sceneDistance(x, y, ray, options), nearest: ReferenceImageHit | null = null;
    for (const image of this.images.values()) {
      const { input } = image;
      if (snapshot.get(input.id) !== image) continue;
      if (!input.visible || input.locked || input.opacity === 0) continue;
      const hit = referenceImageHit(input.id, input.corners, ray, distance);
      if (hit) { nearest = hit; distance = hit.distance; }
    }
    return nearest;
  }
}
