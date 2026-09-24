/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The screen-space passes that run after the main scene pass, in order:
 * ambient occlusion (`ao-pass.ts`), separation lines (`post-processor.ts`)
 * and eye-dome lighting (`edl-pass.ts`). Each darkens the resolved canvas
 * colour, reading the scene depth (and object-id) attachments.
 *
 * Every pass is built on the first frame that needs it, so a session that
 * never enables one pays nothing for it. A pass whose construction throws
 * (for example on a mobile GPU that cannot bind a depth texture) is disabled
 * for the rest of the chain's life with one warning, and frames render
 * without it. The ambient-occlusion pass owns screen-sized targets, so it is
 * released as soon as its option is switched off (not while the interaction
 * governor merely pauses it), the way the shadow map is.
 *
 * The renderer creates the chain on its first frame and destroys it in
 * teardown, so device-loss recovery rebuilds every pass against the new
 * device.
 */

import { AoPass } from './ao-pass.js';
import type { WebGPUDevice } from './device.js';
import { EdlPass, type EdlPassOptions } from './edl-pass.js';
import { PostProcessor } from './post-processor.js';
import type { Mat4 } from './types.js';
import { livePostEffects, type ResolvedVisualEnhancement } from './visual-enhancement.js';

export interface PostPassFrame {
  encoder: GPUCommandEncoder;
  /** Resolved colour (the canvas texture) every pass darkens. */
  targetView: GPUTextureView;
  /** Drawing-buffer size in pixels. */
  width: number;
  height: number;
  /** Depth-only view of the scene depth attachment. */
  depthView: GPUTextureView;
  objectIdView: GPUTextureView;
  /** Camera projection the frame was drawn with. */
  projection: Mat4;
  enhancement: ResolvedVisualEnhancement;
  /** The interaction-effects governor's verdict for this frame. */
  effectsLive: boolean;
  /** Device px per CSS px: pixel radii are CSS px, the passes tap texels (#5383). */
  pixelRatio: number;
  /** Eye-dome lighting settings, or null when it does not run this frame. */
  edl: Required<EdlPassOptions> | null;
}

type PassName = 'ambient occlusion' | 'separation lines' | 'eye-dome lighting';

export class PostPassChain {
  private ao: AoPass | null = null;
  private separation: PostProcessor | null = null;
  private edl: EdlPass | null = null;
  private readonly failed = new Set<PassName>();

  constructor(private readonly device: WebGPUDevice, private readonly sampleCount: number) {}

  encode(frame: PostPassFrame): void {
    const ve = frame.enhancement;
    const live = livePostEffects(ve, frame.effectsLive);

    if (this.ao && (!ve.enabled || ve.contactShading.quality === 'off')) {
      this.ao.destroy();
      this.ao = null;
    }
    if (live.ambientOcclusion !== null) {
      this.ao ??= this.build('ambient occlusion', () =>
        new AoPass(this.device.getDevice(), this.device.getFormat(), this.sampleCount));
      this.ao?.encode({
        encoder: frame.encoder,
        targetView: frame.targetView,
        depthView: frame.depthView,
        params: {
          projection: frame.projection,
          width: frame.width,
          height: frame.height,
          quality: live.ambientOcclusion,
          radius: ve.contactShading.radius,
          intensity: ve.contactShading.intensity,
        },
      });
    }

    if (live.separationLines) {
      this.separation ??= this.build('separation lines', () => new PostProcessor(this.device, this.sampleCount));
      this.separation?.apply(frame.encoder, {
        targetView: frame.targetView,
        depthView: frame.depthView,
        objectIdView: frame.objectIdView,
        quality: ve.separationLines.quality === 'high' ? 'high' : 'low',
        radius: ve.separationLines.radius * frame.pixelRatio,
        intensity: ve.separationLines.intensity,
      });
    }

    // Eye-dome lighting runs last so it darkens every layer above uniformly.
    if (frame.edl) {
      this.edl ??= this.build('eye-dome lighting', () => new EdlPass(this.device, this.sampleCount));
      this.edl?.apply(
        frame.encoder,
        { targetView: frame.targetView, depthView: frame.depthView },
        { ...frame.edl, radiusPx: frame.edl.radiusPx * frame.pixelRatio },
      );
    }
  }

  private build<T>(name: PassName, create: () => T): T | null {
    if (this.failed.has(name)) return null;
    try {
      return create();
    } catch (e) {
      this.failed.add(name);
      console.warn(`[Renderer] ${name} pass unavailable; rendering without it:`, e);
      return null;
    }
  }

  /** Release every pass. Idempotent. */
  destroy(): void {
    this.ao?.destroy();
    this.ao = null;
    this.separation?.destroy();
    this.separation = null;
    this.edl?.destroy();
    this.edl = null;
  }
}
