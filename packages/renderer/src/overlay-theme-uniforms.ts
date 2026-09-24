/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GPU/state plumbing for `Renderer.setOverlayTheme` (#5484), pulled out of
 * `pipeline.ts` and `renderer-overlays.ts` so neither module carries this
 * theme's bookkeeping inline (both were pushed over their `check-module-size`
 * budget by it).
 */

import { DEFAULT_OVERLAY_THEME, type OverlayTheme } from './overlay-theme.js';
import type { SectionPlaneRenderer } from './section-plane.js';
import type { Section2DOverlayRenderer } from './section-2d-overlay.js';

/**
 * The selection highlight tint: group(1) binding 4, a standalone 16-byte
 * uniform written only by `update()` (on `Renderer.setOverlayTheme`), never
 * per-frame — unlike `RenderPipeline`'s `environmentBuffer`, which IS
 * rewritten every frame from `RenderOptions.environment`.
 */
export class SelectionColorUniform {
  readonly buffer: GPUBuffer;
  private readonly device: GPUDevice;

  constructor(device: GPUDevice) {
    this.device = device;
    this.buffer = device.createBuffer({
      label: 'selection-color-uniform',
      size: 16, // vec4<f32>
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    // Seed with the historic hardcoded selection blue, linear-light decoded
    // (see `DEFAULT_OVERLAY_THEME.selection`) so a caller that never calls
    // `update()` sees no visual change.
    device.queue.writeBuffer(this.buffer, 0, new Float32Array(DEFAULT_OVERLAY_THEME.selection));
  }

  /** Write the selection tint. 16 bytes; called only from `Renderer.setOverlayTheme`. */
  update(color: readonly [number, number, number, number]): void {
    this.device.queue.writeBuffer(this.buffer, 0, new Float32Array(color));
  }

  destroy(): void {
    this.buffer.destroy();
  }
}

/**
 * Applies an `OverlayTheme` to the section-plane preview and section-2D
 * overlay (line/section-cut) renderers, and remembers the last theme set so
 * a pre-init `setTheme` call — or a later re-init after device loss — still
 * lands once those GPU objects exist.
 */
export class OverlayThemeApplier {
  private theme: OverlayTheme = DEFAULT_OVERLAY_THEME;

  get current(): OverlayTheme {
    return this.theme;
  }

  /** Set a new theme and apply it to whichever renderers already exist (either may be null pre-init). */
  set(
    theme: OverlayTheme,
    sectionPlaneRenderer: SectionPlaneRenderer | null,
    section2DOverlayRenderer: Section2DOverlayRenderer | null,
  ): void {
    this.theme = theme;
    section2DOverlayRenderer?.setOverlayLineColor(theme.overlayLine);
    sectionPlaneRenderer?.setPlaneColor(theme.sectionPlane);
  }

  /** Re-apply the current theme to freshly (re)created renderers, e.g. from `init()`. */
  reapply(sectionPlaneRenderer: SectionPlaneRenderer, section2DOverlayRenderer: Section2DOverlayRenderer): void {
    section2DOverlayRenderer.setOverlayLineColor(this.theme.overlayLine);
    sectionPlaneRenderer.setPlaneColor(this.theme.sectionPlane);
  }
}
