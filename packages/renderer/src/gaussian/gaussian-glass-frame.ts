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
 * A failed split may be incomplete: replay held draws, stop splats, then request a clean
 * single-pass frame. Split stays disabled until release() or a new device.
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
  private failed = false;
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
    if (this.split && this.split.device !== device) this.release();
    const disabled = this.failed ? 'split-failed' : this.mode === 'single-pass' ? 'single-pass-mode' : depthInterval ? null : 'upstream-interval-missing';
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
        // Any throw can follow recorded draws; never retry splats in this frame.
        scene.encode({ ...target, resolveTarget: undefined }, camera, { bound: nearest, compare: 'less-equal' });
        bound = nearest;
      } catch (error) {
        failed = true;
        console.error('[Gaussian] splats behind transparent IFC failed; frame may be incomplete:', error);
      }
    }
    const last = !scene || !camera;
    const colour: GPURenderPassColorAttachment = { view: target.colorView, loadOp: 'load', ...(last && target.resolveTarget
      ? { resolveTarget: target.resolveTarget, storeOp: 'discard' } : { storeOp: 'store' }) };
    try {
      const pass = visibility.resume(target.encoder, {
        label: 'ifc-lite-gaussian-transparent',
        colorAttachments: [colour, ...(input.objectIdView ? [{ view: input.objectIdView, loadOp: 'load' as const, storeOp: input.objectIdStore ?? 'discard' }] : [])],
        depthStencilAttachment: { view: target.depthView, depthLoadOp: 'load', depthStoreOp: 'store', stencilLoadOp: 'load', stencilStoreOp: 'discard' },
      });
      try {
        recorder.replay(pass, { initial });
      } finally {
        pass.end();
      }
    } catch (error) {
      if (isPendingVisibility(error)) throw error; // readiness: discard the frame without disabling the split
      this.fail(recorder);
      failed = true;
      console.error('[Gaussian] transparent IFC replay failed; frame may be incomplete:', error);
    }
    if (failed) { this.fail(recorder); encodeResolveOnly(target); return false; }
    if (!scene || !camera) { this.finish(recorder, false); return true; }
    try {
      scene.encode({ ...target, resolveTarget: undefined }, camera, bound ? { bound, compare: 'greater' } : undefined);
    } catch (error) {
      failed = true;
      console.error('[Gaussian] splats in front of transparent IFC failed; frame may be incomplete:', error);
    }
    if (failed) this.fail(recorder);
    else this.finish(recorder, true);
    encodeResolveOnly(target); // keep MSAA stored until either split outcome is known
    return !failed;
  }

  /** After the frame's command buffer is submitted: start reading the layer count back. */
  submitted(): void { this.split?.split.submitted(); }

  /** Clean slate on device loss/recovery or renderer rebuild; mode changes do not reset failures. */
  release(): void {
    this.last = null;
    this.report = NO_TRANSPARENT;
    this.failed = false;
    this.split?.split.destroy();
    this.split = null;
  }

  private fail(recorder: DeferredPassRecorder): void {
    const first = !this.failed;
    this.failed = true;
    this.finish(recorder, false, 'split-failed');
    if (first) this.requestRender();
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
      later: (recorder?.laterDraws ?? 0) > 0, incomplete: failure === 'split-failed', fallback: failure ?? recorder?.fallback ?? null,
    };
    this.publish();
  }

  /** The last splat frame's report, with its own layer count once that reads back. */
  private publish(): void {
    if (this.last) this.report = compositionReport(this.last, this.split?.split.layers ?? 'unknown');
  }
}
