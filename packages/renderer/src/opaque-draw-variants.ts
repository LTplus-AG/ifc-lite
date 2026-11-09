/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Cheaper twins of the three opaque, depth-writing main-pass pipelines (flat,
 * quantized, instanced), swapped in per frame only where they draw the same
 * pixels:
 *
 * - **discard-free**: the fragment stage from `main-opaque-fast.wgsl.ts`. With
 *   no `discard` in the shader the GPU can reject occluded fragments before
 *   shading them (early depth). Legal only while nothing can clip or hide a
 *   fragment of that draw: no section plane, extra plane or clip box, and for
 *   the instanced pass no hidden/suppressed occurrence and no translucent one
 *   (the opacity routing discard).
 * - **no object id**: the object-id colour target keeps its attachment (every
 *   pipeline in the pass must agree on the target formats) but gets
 *   `writeMask: 0`, so the GPU stops writing a multisampled RGBA8 surface per
 *   fragment on frames whose edge pass will not read it.
 *
 * Only perspective frames use them. An orthographic frame replays its opaque
 * draws through `OpaqueVisibilityPass`, which only guards pipelines it
 * registered, and its guard adds a discard back anyway.
 *
 * Every twin is compiled asynchronously on first request and the base pipeline
 * draws until it lands, so no frame waits on a compile and a backend that
 * rejects a twin simply keeps the base. Nothing here runs at init: CI's
 * SwiftShader loses the device on extra pipeline creation during startup.
 */

export type OpaqueDrawKind = 'flat' | 'quantized' | 'instanced';

/** What this frame's opaque draws of one kind may skip. */
export interface OpaqueDrawMode {
  /** No fragment of the draw can be discarded: use the discard-free shader. */
  discardFree: boolean;
  /** The edge pass reads the object-id target this frame. */
  objectId: boolean;
}

/** The base pipelines' own mode: the full shader, writing the object id. */
export const BASE_OPAQUE_MODE: OpaqueDrawMode = Object.freeze({ discardFree: false, objectId: true });

export interface OpaqueModeInputs {
  perspective: boolean;
  /** A section plane, extra cutting plane or clip box is active this frame. */
  clipping: boolean;
  /** The edge pass runs this frame (`livePostEffects(...).edges`). */
  edges: boolean;
  /** Instanced pass only: an occurrence is hidden, suppressed or translucent. */
  instancedDiscards?: boolean;
}

/** Pure per-frame decision; `BASE_OPAQUE_MODE` whenever a twin could differ. */
export function resolveOpaqueDrawMode(inputs: OpaqueModeInputs): OpaqueDrawMode {
  if (!inputs.perspective) return BASE_OPAQUE_MODE;
  return {
    discardFree: !inputs.clipping && inputs.instancedDiscards !== true,
    objectId: inputs.edges,
  };
}

/**
 * Derive the twin descriptor from a base. Only the fragment stage moves to the
 * fast module: the vertex stage stays the base pipeline's own compiled entry,
 * so the twin writes bit-identical depth and the selection highlight's
 * `'greater-equal'` redraw (main module) still lands exactly on it. The
 * object-id target keeps its format and loses its writes.
 */
export function opaqueVariantDescriptor(
  base: GPURenderPipelineDescriptor,
  mode: OpaqueDrawMode,
  fastModule: () => GPUShaderModule,
): GPURenderPipelineDescriptor {
  const fragment = base.fragment;
  if (!fragment) throw new Error('Opaque draw variants need a fragment stage');
  const module = mode.discardFree ? fastModule() : fragment.module;
  const targets = [...fragment.targets].map((target, index) =>
    index === 1 && target && !mode.objectId ? { ...target, writeMask: 0 } : target);
  return {
    ...base,
    label: `${base.label ?? 'opaque'}${mode.discardFree ? '-discard-free' : ''}${mode.objectId ? '' : '-no-object-id'}`,
    fragment: { ...fragment, module, targets },
  };
}

export class OpaqueDrawVariants {
  private readonly built = new Map<string, GPURenderPipeline>();
  private readonly requested = new Set<string>();
  private fastModule: GPUShaderModule | null = null;
  private destroyed = false;

  constructor(
    private readonly device: GPUDevice,
    private readonly fastSource: string,
    private readonly bases: Readonly<Record<OpaqueDrawKind, GPURenderPipelineDescriptor>>,
  ) {}

  /** The ready twin for `mode`, or null (draw with the base pipeline) while it compiles, failed, or `mode` is the base. */
  get(kind: OpaqueDrawKind, mode: OpaqueDrawMode): GPURenderPipeline | null {
    if (this.destroyed || (!mode.discardFree && mode.objectId)) return null;
    const key = `${kind}:${mode.discardFree ? 1 : 0}${mode.objectId ? 1 : 0}`;
    const ready = this.built.get(key);
    if (ready) return ready;
    if (!this.requested.has(key)) {
      this.requested.add(key);
      this.build(key, kind, mode);
    }
    return null;
  }

  private build(key: string, kind: OpaqueDrawKind, mode: OpaqueDrawMode): void {
    const descriptor = opaqueVariantDescriptor(this.bases[kind], mode, () =>
      (this.fastModule ??= this.device.createShaderModule({ label: 'main-opaque-discard-free', code: this.fastSource })));
    this.device.createRenderPipelineAsync(descriptor).then(
      (pipeline) => { if (!this.destroyed) this.built.set(key, pipeline); },
      (err) => console.warn(`[Pipeline] ${descriptor.label} unavailable; drawing with the base pipeline:`, err),
    );
  }

  destroy(): void {
    this.destroyed = true;
    this.built.clear();
  }
}
