/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Distinct highlight tints for the two elements of a focused clash pair
 * (#1277, #1339). Before #1339, both clashing elements were highlighted with
 * the single selection-blue, so you couldn't tell which was which. These
 * feed a colour-override map (`setPendingColorUpdates` / `setClashHighlightColors`),
 * the same plain material-colour-override path any other IFC colour takes —
 * NOT the re-lit selection treatment — so the pair pops as a colour change
 * without a selected state or the selection-blue.
 *
 * As of #5484 the two values below are sourced from the `clash-a` /
 * `clash-b` design tokens (#5483, `overlay-theme.ts`) and kept live by
 * {@link setClashColorsFromTheme}, which the viewer calls on theme change.
 * They stay exported `const` bindings, mutated IN PLACE rather than
 * reassigned: many call sites (`group-focus.ts`, `guid-occurrence-colors.ts`)
 * compare a colour to these by reference (`=== CLASH_COLOR_A`) to classify
 * which side of a clash pair a GUID belongs to, and reassigning the binding
 * would silently break every one of those checks the next time the theme
 * changed — mutating the same array keeps every existing reference valid.
 *
 * The third clash colour, the overlap box / contact lines / intersection
 * solid, is not held here: the renderer draws those in its overlay theme's
 * `clashOverlap` (fed from the `clash-overlap` token by
 * `rendererOverlayTheme`), so a theme switch recolours a focused clash's
 * overlap in place (#5490). The panel reads the same tokens as Tailwind
 * utilities (`bg-clash-a`, `text-clash-overlap`), so pair and overlap read
 * the same in the panel and in 3D.
 *
 * RGBA floats in 0..1, sRGB-direct (the renderer's material-colour convention
 * — see `OverlayTheme` in `@ifc-lite/renderer`). Warm-vs-cool so they stay
 * distinct from each other, from the selection accent, and under red/green
 * colour-vision deficiency (amber vs cyan, not red vs green).
 */
import type { ThemeMode } from '@/store/slices/uiSlice';
import { OVERLAY_PALETTES, tokenToRgba } from '@/lib/viewport-ui/overlay-theme';

export type RGBA = [number, number, number, number];

/** Element A — the `clash-a` token; the light theme's value until {@link setClashColorsFromTheme} runs. */
export const CLASH_COLOR_A: RGBA = [...tokenToRgba(OVERLAY_PALETTES.light['clash-a'])];
/** Element B — the `clash-b` token; the light theme's value until {@link setClashColorsFromTheme} runs. */
export const CLASH_COLOR_B: RGBA = [...tokenToRgba(OVERLAY_PALETTES.light['clash-b'])];

/**
 * Refresh the two pair tints above IN PLACE from the current theme's design
 * tokens (#5484/#5483). Call on theme change — every existing reference to
 * `CLASH_COLOR_A` / `_B`, including the identity (`===`) comparisons noted
 * above, keeps working because the array identity never changes, only its
 * contents.
 */
export function setClashColorsFromTheme(theme: ThemeMode): void {
  const palette = OVERLAY_PALETTES[theme];
  writeRgba(CLASH_COLOR_A, tokenToRgba(palette['clash-a']));
  writeRgba(CLASH_COLOR_B, tokenToRgba(palette['clash-b']));
}

function writeRgba(target: RGBA, value: readonly [number, number, number, number]): void {
  target[0] = value[0];
  target[1] = value[1];
  target[2] = value[2];
  target[3] = value[3];
}

/**
 * Build the global-id → colour map that paints a clash pair. `null` ids (an
 * element that didn't resolve to a loaded entity) are skipped. The two colours
 * are always distinct so the pair is readable.
 */
export function buildClashPairColors(
  aRef: number | null,
  bRef: number | null,
): Map<number, RGBA> {
  const map = new Map<number, RGBA>();
  if (aRef !== null) map.set(aRef, CLASH_COLOR_A);
  // If both refs resolve to the SAME id (degenerate self-clash), A's colour
  // already won — don't overwrite with B.
  if (bRef !== null && bRef !== aRef) map.set(bRef, CLASH_COLOR_B);
  return map;
}

/**
 * Convert one of the RGBA floats above (0..1, alpha ignored) to the ARGB hex
 * string BCF's `<Coloring>/<Color Color="...">` expects (e.g. `'FFFF8000'` —
 * see `BCFColoring.color` in `@ifc-lite/bcf`'s types, and the round-trip
 * fixture in `packages/bcf/src/writer.test.ts`). Alpha is always written
 * opaque (`FF`): these are UI highlight tints, not translucency the exported
 * viewpoint needs to reproduce.
 */
export function clashColorToBcfArgb(rgba: RGBA): string {
  const channel = (v: number): string =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, '0')
      .toUpperCase();
  return `FF${channel(rgba[0])}${channel(rgba[1])}${channel(rgba[2])}`;
}
