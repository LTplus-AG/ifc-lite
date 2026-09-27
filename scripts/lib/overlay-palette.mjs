/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Detection logic behind `scripts/check-overlay-palette.mjs` (#5487, part of
 * the #5478 charter). Pure functions over strings so
 * `scripts/check-overlay-palette.test.mjs` can assert on them directly,
 * without touching a real checkout — same split as `scripts/lib/css-vars.mjs`
 * behind `check-css-vars.mjs` and `scripts/lib/asset-usage.mjs` behind
 * `check-asset-usage.mjs`.
 *
 * BACKGROUND. The #5478 audit found ~35 independently positioned viewport
 * overlays, each picking its own accent: violet `#9C6BDE` for the custom
 * section plane, purple `#a855f7` for split/wall handles and edit mode, a
 * hard-coded selection blue in `main.wgsl.ts`, and z-index values ranging
 * from `z-10` to `z-[9999]`. #5483 shipped a token module
 * (`apps/viewer/src/lib/viewport-ui/overlay-theme.ts`) and a z scale
 * (`z-(--z-hud)`); this gate stops a NEW hard-coded literal from landing
 * next to it, without demanding the whole sweep (#5488-#5512) happen first.
 *
 * WHAT COUNTS AS "VIEWPORT CODE". Per the #5478 charter's own list of swept
 * components, three things:
 *  - every file under `components/viewport-ui/**` (the HUD and scene kernel)
 *  - every file under `components/viewer/tools/**` (the per-tool overlays:
 *    Measure, Section, Split, Zone, Space Sketch, Add Element, ...)
 *  - the specific overlay files the charter names by component: the
 *    ViewportContainer, ViewportOverlays, ToolOverlays, AnnotationLayer,
 *    CollabPresenceLayer, BCFOverlay, and the viewport banners
 *    (MergeLayersBanner, GeometryModeBanner, LandXmlUnitsRefusalPrompt — the
 *    components rendered directly over the canvas by ViewportContainer).
 * The 2D drawing window the charter also names is deliberately EXCLUDED: by
 * the time this gate landed, #5492-#5495 had already moved it into the panel
 * registry (`components/viewer/drawing/DrawingPanel.tsx`), so it is a panel,
 * not a viewport overlay, and its `IFC_TYPE_FILL_COLORS` drafting palette is
 * a documented sanctioned exception (AGENTS.md, "Colour and coordinate
 * resolution") rather than a defect this gate should flag.
 *
 * The **token module itself**, `apps/viewer/src/lib/viewport-ui/overlay-theme.ts`,
 * lives under `lib/viewport-ui/`, not `components/viewport-ui/`, so it is
 * outside this scope by construction — it is where hex/rgb values are
 * SUPPOSED to live.
 *
 * WHAT COUNTS AS A VIOLATION.
 *  - `findHexOrRgbLiterals`: a `#rgb`/`#rgba`/`#rrggbb`/`#rrggbbaa` hex colour
 *    or an `rgb(`/`rgba(` function call, anywhere in viewport code. JS/TS
 *    comments are stripped first so an issue reference like `// #5486` is
 *    never mistaken for a colour (every digit is technically a valid hex
 *    digit). A trailing hyphen or further hex digit right after the match
 *    (`#add-elem-glow`, an SVG `url(#id)` fragment) rules it out too — a
 *    fragment identifier is not a colour merely because its name happens to
 *    scan as one.
 *  - `findPurpleFamilyUtilities`: a Tailwind `purple-`/`violet-`/`indigo-`/
 *    `fuchsia-` shade utility, scanned across the WHOLE viewer
 *    (`apps/viewer/src`), not just viewport code — the charter's colour
 *    decision (#5478, "retire the purple family") is viewer-wide: the
 *    colourful theme's primary is purple, so ANY `purple-500`-style utility
 *    anywhere in the viewer risks turning the intended interaction accent
 *    into the theme's own colour.
 *  - `findRawZIndex`: a bare Tailwind `z-<digits>` or arbitrary `z-[...]`
 *    utility in viewport code. The token z scale from #5483 is the function
 *    form `z-(--z-hud)`, which this pattern does not match — that form is
 *    the intended replacement, not a violation.
 */

const VIEWPORT_UI_PREFIX = 'apps/viewer/src/components/viewport-ui/';
const VIEWER_TOOLS_PREFIX = 'apps/viewer/src/components/viewer/tools/';

/**
 * The overlay files the #5478 charter names by component, beyond the two
 * directory globs above. See the file-header comment for why the 2D drawing
 * window is not here.
 */
export const VIEWPORT_OVERLAY_FILES = [
  'apps/viewer/src/components/viewer/ViewportContainer.tsx',
  'apps/viewer/src/components/viewer/ViewportOverlays.tsx',
  'apps/viewer/src/components/viewer/ToolOverlays.tsx',
  'apps/viewer/src/components/viewer/annotations/AnnotationLayer.tsx',
  'apps/viewer/src/components/viewer/CollabPresenceLayer.tsx',
  'apps/viewer/src/components/viewer/bcf/BCFOverlay.tsx',
  'apps/viewer/src/components/viewer/MergeLayersBanner.tsx',
  'apps/viewer/src/components/viewer/GeometryModeBanner.tsx',
  'apps/viewer/src/components/viewer/LandXmlUnitsRefusalPrompt.tsx',
  // Overlays drawn over the canvas that the list above missed (#5490): the
  // axis helper reads `IFC_AXIS_COLORS`, so a hard-coded triad coming back is
  // a new hex literal here; the model-origin markers' status colours are frozen.
  'apps/viewer/src/components/viewer/AxisHelper.tsx',
  'apps/viewer/src/components/viewer/BasepointOverlay.tsx',
];

/** Directory used to scope the whole-viewer purple-family scan. */
export const VIEWER_SCAN_DIR = 'apps/viewer/src/';

/**
 * Is `repoRelativePath` (POSIX-separated, e.g. from `git ls-files`) inside
 * the "viewport code" scope defined above?
 */
export function isViewportFile(repoRelativePath) {
  return (
    repoRelativePath.startsWith(VIEWPORT_UI_PREFIX) ||
    repoRelativePath.startsWith(VIEWER_TOOLS_PREFIX) ||
    VIEWPORT_OVERLAY_FILES.includes(repoRelativePath)
  );
}

/** Strip `//` and `/* *\/` comments, preserving line breaks so line numbers
 * computed on the result still line up with the original source (a `\n`
 * inside a removed block comment is kept; every other removed character
 * becomes a space). */
export function stripJsComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
}

function lineOf(content, index) {
  return content.slice(0, index).split('\n').length;
}

/**
 * `#rgb`/`#rgba`/`#rrggbb`/`#rrggbbaa` hex colours and `rgb(`/`rgba(`
 * function calls, with comments already stripped from `content` by the
 * caller (see `stripJsComments`). Deliberately excludes non-colour
 * fragment/id references such as `url(#add-elem-glow)`: the hex-length
 * match must not be immediately followed by another hex digit or a hyphen.
 */
export function findHexOrRgbLiterals(content) {
  const hits = [];
  const hexRe = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-fA-F-])/g;
  let m;
  while ((m = hexRe.exec(content))) {
    hits.push({ line: lineOf(content, m.index), match: m[0] });
  }
  const rgbRe = /\brgba?\(/g;
  while ((m = rgbRe.exec(content))) {
    hits.push({ line: lineOf(content, m.index), match: m[0] });
  }
  return hits;
}

/** Tailwind `purple-`/`violet-`/`indigo-`/`fuchsia-` shade utilities. */
export function findPurpleFamilyUtilities(content) {
  const hits = [];
  const re = /\b(?:purple|violet|indigo|fuchsia)-[0-9]{2,3}\b/g;
  let m;
  while ((m = re.exec(content))) {
    hits.push({ line: lineOf(content, m.index), match: m[0] });
  }
  return hits;
}

/**
 * Bare `z-<digits>` / `z-[...]` utilities. Does not match the token z-scale
 * function form `z-(--z-hud)` from #5483 — that is the intended
 * replacement, not a violation.
 */
export function findRawZIndex(content) {
  const hits = [];
  // Two alternatives, not one `\bz-(?:\[...\]|\d+)\b`: a trailing `\b` after
  // a `]` never matches (`]` and the space/quote that follows it are both
  // non-word characters, so there is no word-boundary transition there),
  // which silently dropped every `z-[45]`-style arbitrary-value class.
  const re = /\bz-\[[^\]]+\]|\bz-[0-9]+\b/g;
  let m;
  while ((m = re.exec(content))) {
    hits.push({ line: lineOf(content, m.index), match: m[0] });
  }
  return hits;
}
