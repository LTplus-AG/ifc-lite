/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Frame schedule of the nearest-glass split (#8564, option B). In a frame with
 * splats and transparent IFC, after the main pass (which held back transparent
 * IFC and the selection highlight):
 *   1. P1 (nearest transparent depth per sample) and the layer count;
 *   2. splats with depth <= P1 per sample (behind or at the glass);
 *   3. the held draws exactly as recorded: transparent IFC, the highlight, then points,
 *      reference images and overlays in their established order;
 *   4. splats with depth > P1 (in front of the glass), resolving MSAA.
 * A split pass that fails falls back to the held draws plus one splat pass (`split-failed`).
 * Every splat sample lands in exactly one of 2 and 4: same depth value, same
 * P1 value, complementary tests. Both still test opaque depth in hardware, as
 * the single pass does. Where no transparent IFC covers a sample, P1 is the far
 * plane and every splat sample is drawn in 4, in the single pass's order.
 */

import type { GaussianBackendScene, GaussianEncodeCamera, GaussianEncodeTarget } from './gaussian-backend.js';
import {
  compositionReport, NO_TRANSPARENT,
  type GaussianCompositionFallback, type GaussianCompositionMode, type GaussianCompositionReport,
} from './gaussian-composition.js';
import { GaussianGlassSplit, type DescribePipeline } from './gaussian-glass-split.js';
import { DeferredPassRecorder } from './gaussian-pass-recorder.js';
export type { DeferredPassRecorder } from './gaussian-pass-recorder.js';
export type { GaussianCompositionMode } from './gaussian-composition.js';
import { encodeResolveOnly } from './gaussian-frame.js';
import { GaussianSplatError } from './gaussian-errors.js';
import { isPendingVisibility } from '../opaque-visibility-pass.js';

/** The renderer's opaque-visibility pass: registered descriptors and same-frame later passes. */
export interface GlassVisibility {
  describe: DescribePipeline;
  resume(encoder: GPUCommandEncoder, descriptor: GPURenderPassDescriptor): GPURenderPassEncoder;
}

/** What a split frame needs beyond the single splat pass's target. */
export interface GlassFrameInput {
  readonly recorder?: DeferredPassRecorder | null;
  readonly objectIdView?: GPUTextureView;
  readonly objectIdStore?: GPUStoreOp;
  readonly visibility?: GlassVisibility;
  /** Bind groups the held draws inherit from the main pass (environment, section exclusions). */
  readonly initialBindGroups?: ReadonlyArray<readonly [number, GPUBindGroup]>;
}

export class GaussianGlassComposer {
  private mode: GaussianCompositionMode = 'nearest-glass-split';
  private split: { device: GPUDevice; split: GaussianGlassSplit } | null = null;
  /** What the last splat frame did; its report is rebuilt when that frame's layer count arrives. */
  private last: Parameters<typeof compositionReport>[0] | null = null;
  report: GaussianCompositionReport = NO_TRANSPARENT;

  constructor(private readonly requestRender: () => void) {}

  setMode(mode: GaussianCompositionMode): void {
    if (mode !== 'nearest-glass-split' && mode !== 'single-pass') throw new GaussianSplatError('invalid-placement', `Unknown Gaussian composition mode ${String(mode)}.`);
    this.mode = mode;
    this.requestRender();
  }

  /** A fresh recorder for one splat frame; it holds transparent IFC only when the split can run. */
  recorder(device: GPUDevice, depthInterval: boolean, visibility: GlassVisibility): DeferredPassRecorder {
    const disabled = this.mode === 'single-pass' ? 'single-pass-mode' : depthInterval ? null : 'upstream-interval-missing';
    return new DeferredPassRecorder(disabled, (pipelines) => this.splitFor(device).prepare(pipelines, (pipeline) => visibility.describe(pipeline)));
  }

  /**
   * Record the frame's splat passes; ends with the pass that resolves MSAA. False when a splat
   * pass failed (logged; the frame still resolves). An orthographic variant still compiling
   * propagates: the renderer defers the whole frame.
   */
  encode(scene: GaussianBackendScene | null, target: GaussianEncodeTarget, camera: GaussianEncodeCamera | null, input: GlassFrameInput): boolean {
    const recorder = input.recorder;
    this.split?.split.beginFrame();
    const split = recorder?.deferred && input.visibility && this.split ? this.split.split : null;
    if (!split || !recorder || !input.visibility) {
      this.finish(recorder, false);
      try {
        if (scene && camera) scene.encode(target, camera); else encodeResolveOnly(target);
        return true;
      } catch (error) {
        console.error('[Gaussian] splat pass failed; the frame still resolved:', error);
        return false;
      }
    }
    return this.encodeSplit(split, recorder, input.visibility, scene, target, camera, input);
  }

  private encodeSplit(
    split: GaussianGlassSplit, recorder: DeferredPassRecorder, visibility: GlassVisibility, scene: GaussianBackendScene | null,
    target: GaussianEncodeTarget, camera: GaussianEncodeCamera | null, input: GlassFrameInput,
  ): boolean {
    const initial = input.initialBindGroups ?? [];
    let bound: GPUTexture | null = null, failed = false;
    if (scene && camera) {
      try {
        const nearest = split.encodeNearest({ ...target, initial }, recorder);
        // The backend prepares an interval draw before beginning its pass, so a throw here records no splats.
        scene.encode({ ...target, resolveTarget: undefined }, camera, { bound: nearest, compare: 'less-equal' });
        bound = nearest;
      } catch (error) {
        failed = true; // no P1 filter below: every splat draws once, in one pass after the held draws
        console.error('[Gaussian] splats behind transparent IFC failed; falling back to one splat pass:', error);
      }
    }
    const last = !scene || !camera;
    const colour: GPURenderPassColorAttachment = { view: target.colorView, loadOp: 'load', ...(last && target.resolveTarget
      ? { resolveTarget: target.resolveTarget, storeOp: 'discard' } : { storeOp: 'store' }) };
    const pass = visibility.resume(target.encoder, {
      label: 'ifc-lite-gaussian-transparent',
      colorAttachments: [colour, ...(input.objectIdView ? [{ view: input.objectIdView, loadOp: 'load' as const, storeOp: input.objectIdStore ?? 'discard' }] : [])],
      depthStencilAttachment: { view: target.depthView, depthLoadOp: 'load', depthStoreOp: 'store', stencilLoadOp: 'load', stencilStoreOp: 'discard' },
    });
    try {
      recorder.replay(pass, { initial });
    } catch (error) {
      if (isPendingVisibility(error)) throw error; // the renderer defers the whole frame
      console.error('[Gaussian] transparent IFC replay failed; the frame still resolves:', error);
    } finally {
      pass.end();
    }
    if (!scene || !camera) { this.finish(recorder, false); return true; }
    try {
      scene.encode(target, camera, bound ? { bound, compare: 'greater' } : undefined);
    } catch (error) {
      failed = true;
      console.error('[Gaussian] splats in front of transparent IFC failed; the frame still resolved:', error);
    }
    this.finish(recorder, !failed, failed ? 'split-failed' : null);
    return !failed;
  }

  /** After the frame's command buffer is submitted: start reading the layer count back. */
  submitted(): void { this.split?.split.submitted(); }

  release(): void {
    this.split?.split.destroy();
    this.split = null;
  }

  private splitFor(device: GPUDevice): GaussianGlassSplit {
    if (this.split?.device !== device) {
      this.release();
      this.split = { device, split: new GaussianGlassSplit(device, this.requestRender, () => this.publish()) };
    }
    return this.split.split;
  }

  private finish(recorder: DeferredPassRecorder | null | undefined, split: boolean, failure: GaussianCompositionFallback | null = null): void {
    this.last = {
      transparent: recorder?.transparent ?? false, split, highlight: (recorder?.highlightDraws ?? 0) > 0,
      later: (recorder?.laterDraws ?? 0) > 0, fallback: failure ?? recorder?.fallback ?? null,
    };
    this.publish();
  }

  /** The last splat frame's report, with its own layer count once that reads back. */
  private publish(): void {
    if (this.last) this.report = compositionReport(this.last, this.split?.split.layers ?? 'unknown');
  }
}
