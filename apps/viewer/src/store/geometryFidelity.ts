/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Load-time geometry fidelity: the `fast`/`exact` mode, the tessellation tier,
 * and the sticky `?geomTier=` override that ties them together.
 *
 * Split out of `constants.ts` (which re-exports everything here for its existing
 * consumers) because this is one decision with one failure story — what density
 * and which boolean cuts a load is meshed at — and it was the largest cohesive
 * block in a module long past the ~400-line house limit.
 */

import type { TessellationQuality } from '@ifc-lite/geometry';

/** localStorage key for the sticky tessellation-tier override. */
export const GEOM_TIER_STORAGE_KEY = 'ifc-lite-geom-tier';

/** localStorage key for the load-time geometry fidelity mode (mirrors merge-layers). */
export const GEOMETRY_MODE_STORAGE_KEY = 'ifc-lite-geometry-mode';

// Auto-low tessellation density for heavy models. The on-screen load already
// skips tiny detail boolean cuts on every load (#1286), which removes the
// exact-tier escalations that dominate boolean-heavy steel; this is the
// ORTHOGONAL triangle-count lever - dropping vertex density (low = 0.5x,
// lowest = 0.25x) so a multi-million-triangle model uploads + fits in GPU
// memory fast for first paint. The signal is file size, the only model-weight
// proxy available before geometry runs (the pre-pass job count arrives after
// the cache key is committed). Size correlates with triangle count at scale but
// can't tell a dense-but-small model (e.g. 20 MB detailed steel, ~8M tris) from
// a light one - those still load at medium density (the skip keeps them fast),
// or can be forced low via `?geomTier=low`. Thresholds are deliberately high so
// normal models keep full curve density; tune here.
export const AUTO_LOW_TIER_MB = 50; // >= this -> 'low'
export const AUTO_LOWEST_TIER_MB = 150; // >= this -> 'lowest'

/**
 * Load-time geometry fidelity mode - a user-facing, persistent switch that
 * mirrors the merge-layers load-time input (sticky in localStorage, folded into
 * the geometry cache key, reload-to-apply).
 * - `fast` (default): skip tiny detail boolean cuts (#1286) + auto-low
 *   tessellation density for heavy models, for fast first paint. PREVIEW
 *   fidelity - sub-10% cutters (bolt holes, copes) are dropped and curves may be
 *   coarser; display, measure AND export all read this same geometry, so it is a
 *   deliberate, visible choice rather than a silent default.
 * - `exact`: full boolean cuts + full curve density everywhere - display,
 *   measure and export consistent. Slower on boolean-heavy / dense models.
 */
export type GeometryMode = 'fast' | 'exact';

/** Resolve the initial geometry mode from localStorage; default `fast`. */
export function getInitialGeometryMode(): GeometryMode {
  if (typeof window === 'undefined') return 'fast';
  try {
    return localStorage.getItem(GEOMETRY_MODE_STORAGE_KEY) === 'exact' ? 'exact' : 'fast';
  } catch {
    return 'fast';
  }
}

const TESSELLATION_TIERS: readonly TessellationQuality[] = [
  'lowest',
  'low',
  'medium',
  'high',
  'highest',
];

/**
 * The tiers BELOW the engine default, i.e. the preview ones. They are the tiers
 * `exact` mode must refuse (#2544), and the distinction is not merely about
 * vertex density: `quality_skips_small_cuts` in the Rust boolean processor
 * (`rust/geometry/src/processors/boolean/mod.rs`) is exactly `Lowest | Low`, and
 * it is OR'd with the `skip_small_cuts` flag. So a preview tier drops sub-10%
 * cutters on its own, no matter what the flag says - breaking BOTH halves of the
 * `exact` promise ("full boolean cuts + full curve density"). `medium` and finer
 * break neither, which is why they survive an `exact` load below.
 */
const PREVIEW_TIERS: readonly TessellationQuality[] = ['lowest', 'low'];

/** Whether `tier` is a preview tier (coarser than the engine default). */
export function isPreviewTier(tier: TessellationQuality | undefined): boolean {
  return tier != null && PREVIEW_TIERS.includes(tier);
}

/**
 * Per-host manual override for the load-time tessellation tier, mirroring
 * `getGeomWorkerOverride`. `?geomTier=low` (or lowest/medium/high/highest) sets
 * it AND persists to localStorage so it survives the reload a re-measure needs
 * (and a shared link carries it). `?geomTier=auto` clears the override. Useful
 * for forcing low density on a dense-but-small model the size heuristic can't
 * detect, or pinning full density on a large one.
 */
export function getGeomTierOverride(): TessellationQuality | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const param = new URLSearchParams(window.location.search).get('geomTier');
    if (param != null) {
      if (param === 'auto') {
        localStorage.removeItem(GEOM_TIER_STORAGE_KEY);
        return undefined;
      }
      if ((TESSELLATION_TIERS as readonly string[]).includes(param)) {
        localStorage.setItem(GEOM_TIER_STORAGE_KEY, param);
        return param as TessellationQuality;
      }
    }
    const stored = localStorage.getItem(GEOM_TIER_STORAGE_KEY) ?? '';
    if ((TESSELLATION_TIERS as readonly string[]).includes(stored)) {
      return stored as TessellationQuality;
    }
  } catch (err) {
    // Blocked/unavailable storage (Safari private mode, locked storage) or a
    // bad URL - fall back to the heuristic, but don't swallow silently
    // (AGENTS.md: no silent catch). A persisted ?geomTier override is lost here.
    console.warn('[geom-tier] override read failed; using heuristic', err);
  }
  return undefined;
}

/**
 * Drop `geomTier` from the address bar without navigating.
 *
 * Clearing localStorage alone is NOT enough: `getGeomTierOverride` re-reads the
 * query parameter on every call and re-persists it, so on the originating
 * `?geomTier=low` link the very next load would silently restore the pin - and
 * that link is precisely the case the clear action exists for. Stripping the
 * parameter also stops the user re-sharing a URL that re-pins the next reader.
 */
function stripGeomTierParam(): void {
  if (typeof window === 'undefined') return;
  const href = window.location?.href;
  // Guarded rather than try/caught so the no-DOM test/SSR paths stay silent:
  // absence here is normal, only a real failure below deserves a warning.
  if (typeof href !== 'string' || typeof window.history?.replaceState !== 'function') return;
  try {
    const url = new URL(href);
    if (!url.searchParams.has('geomTier')) return;
    url.searchParams.delete('geomTier');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  } catch (err) {
    console.warn('[geom-tier] could not strip the URL parameter; the pin may return', err);
  }
}

/**
 * Drop any stored `?geomTier=` override, restoring automatic tier selection.
 *
 * The override persists across sessions by design, but nothing in the URL says
 * so after the first visit, so this is the UI's way out (the Visibility menu's
 * "Detail pinned" row) alongside the pre-existing `?geomTier=auto`. Clears BOTH
 * homes of the pin - storage and query string - see `stripGeomTierParam`.
 */
export function clearGeomTierOverride(): void {
  try {
    localStorage.removeItem(GEOM_TIER_STORAGE_KEY);
  } catch (err) {
    // Blocked/unavailable storage. Don't swallow silently (AGENTS.md); the
    // in-memory store still clears, so this load behaves as requested.
    console.warn('[geom-tier] clear failed; override may return on reload', err);
  }
  stripGeomTierParam();
}

/**
 * Resolve the load-time tessellation tier for a model of `fileSizeMB` under the
 * given geometry `mode`. In `fast` mode a manual `?geomTier=` override wins,
 * else auto-low for heavy models by size, else `undefined` (engine default =
 * medium, full curve density). Returning `undefined` at the medium default keeps
 * pre-existing cache entries valid (the tier discriminator is omitted from the
 * cache key at medium - see `buildGeometryCacheKey`).
 *
 * `exact` mode never auto-lows, and since #2544 it also refuses a stored PREVIEW
 * override. The override persists to localStorage from a single `?geomTier=low`
 * link, invisibly and forever, and it used to win in every mode - so a browser
 * that had once opened such a link kept meshing at preview fidelity (coarse
 * curves AND dropped sub-10% cuts, see `isPreviewTier`) while the UI said
 * "Exact: full cuts + density". Display, measure and export all read that
 * geometry, so the mismatch was not cosmetic. A `medium`-or-finer override is
 * still honoured in `exact` mode: pinning full density on a large model is the
 * documented reason the override exists, and it cannot violate the promise.
 *
 * `override` is injectable so the decision is testable without a DOM; callers
 * should omit it and let it read the persisted value.
 */
export function resolveLoadTessellationTier(
  fileSizeMB: number,
  mode: GeometryMode = 'fast',
  override: TessellationQuality | undefined = getGeomTierOverride()
): TessellationQuality | undefined {
  if (mode !== 'fast') return isPreviewTier(override) ? undefined : override;
  if (override) return override;
  if (fileSizeMB >= AUTO_LOWEST_TIER_MB) return 'lowest';
  if (fileSizeMB >= AUTO_LOW_TIER_MB) return 'low';
  return undefined;
}
