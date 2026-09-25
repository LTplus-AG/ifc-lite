/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Bridges the overlay design tokens (#5483, `overlay-theme.ts`) to the
 * renderer's own colour uniforms (#5484, `Renderer.setOverlayTheme`). Pure
 * mapping, no renderer/store access, so it is trivial to unit-test: given a
 * theme name, which token feeds which `OverlayTheme` field, and in which
 * colour space (`Renderer`'s `OverlayTheme` documents the convention per
 * field — `selection` wants true linear-light RGBA because it feeds the
 * lit, ACES-tonemapped pipeline; every other field wants sRGB-direct RGBA
 * because it feeds an unlit pipeline that writes straight to the swapchain,
 * the same convention the token hex values themselves use).
 *
 * `overlay-accent` is the one thing being manipulated (selection AND the
 * section-plane preview — one accent tint for every axis, #5484). Passive
 * marks are ink, so every overlay LINE channel (section-cut outline,
 * IfcAnnotation, alignment, IfcGrid, DXF / LandXML) takes `overlay-ink`.
 */

import type { OverlayTheme as RendererOverlayTheme } from '@ifc-lite/renderer';
import type { ThemeMode } from '@/store/slices/uiSlice';
import { OVERLAY_PALETTES, tokenToLinearRgba, tokenToRgba } from './overlay-theme';

/** The renderer `OverlayTheme` for `theme`, sourced entirely from the design tokens. */
export function rendererOverlayTheme(theme: ThemeMode): RendererOverlayTheme {
  const palette = OVERLAY_PALETTES[theme];
  return {
    selection: tokenToLinearRgba(palette['overlay-accent']),
    sectionPlane: tokenToRgba(palette['overlay-accent']),
    overlayLine: tokenToRgba(palette['overlay-ink']),
    clashA: tokenToRgba(palette['clash-a']),
    clashB: tokenToRgba(palette['clash-b']),
    clashOverlap: tokenToRgba(palette['clash-overlap']),
  };
}
