/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Store constants - extracted magic numbers for maintainability
 */

import type { TypeVisibility } from './types.js';
import type { TessellationQuality } from '@ifc-lite/geometry';

// ============================================================================
// Camera Defaults
// ============================================================================

export const CAMERA_DEFAULTS = {
  /** Default azimuth angle in degrees (horizontal rotation) */
  AZIMUTH: 45,
  /** Default elevation angle in degrees (vertical rotation) */
  ELEVATION: 25,
} as const;

// ============================================================================
// Section Plane Defaults
// ============================================================================

export const SECTION_PLANE_DEFAULTS = {
  /** Default section plane axis */
  AXIS: 'down' as const,
  /** Default section plane position (percentage of model bounds) */
  POSITION: 50,
  /**
   * Default enabled state.
   *
   * MUST be `false`: opening the section tool (button or `x` shortcut)
   * should leave the model uncut and arm pick mode instead — the cut
   * appears only after the user clicks a face (or moves the slider /
   * picks an axis). With `enabled: true` here the user saw a Down cut
   * appear immediately on tool open even though the panel's mount
   * effect was about to arm pick mode (issue #243 follow-up).
   */
  ENABLED: false,
  /** Default flipped state */
  FLIPPED: false,
  /** Default: render filled/hatched cap surfaces at the cut */
  SHOW_CAP: true,
  /** Default: draw polygon outlines on the cut surfaces */
  SHOW_OUTLINES: true,
} as const;

/**
 * Default cut-surface appearance. RGBA tuples are 0-1 per channel. Screen-space
 * hatch settings are in pixels so the hatch stays readable at any zoom level.
 */
export const SECTION_CAP_DEFAULTS = {
  FILL_COLOR:   [0.92, 0.88, 0.78, 1.0] as [number, number, number, number], // warm paper
  STROKE_COLOR: [0.10, 0.10, 0.10, 1.0] as [number, number, number, number], // ink
  PATTERN:      'diagonal' as const,
  SPACING_PX:   8,
  ANGLE_RAD:    Math.PI / 4,
  WIDTH_PX:     1.0,
  SECONDARY_ANGLE_RAD: -Math.PI / 4,
} as const;

// ============================================================================
// Edge Lock / Magnetic Snapping
// ============================================================================

export const EDGE_LOCK_DEFAULTS = {
  /** Initial position along edge (0-1, where 0.5 = midpoint) */
  INITIAL_T: 0.5,
  /** Initial lock strength when edge is first locked */
  INITIAL_STRENGTH: 0.5,
  /** Strength increment per update */
  STRENGTH_INCREMENT: 0.1,
  /** Maximum lock strength */
  MAX_STRENGTH: 1.5,
} as const;

// ============================================================================
// UI Defaults
// ============================================================================

/** Resolve the initial theme: localStorage override > system preference > dark fallback */
function getInitialTheme(): 'light' | 'dark' | 'colorful' {
  if (typeof window === 'undefined') return 'dark';
  const saved = localStorage.getItem('ifc-lite-theme');
  if (saved === 'light' || saved === 'dark' || saved === 'colorful') return saved;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * localStorage key for the "Merge Multilayer Walls" load-time toggle
 * (issue #540). Reading the same key both here and on application
 * boot keeps the user's choice sticky between sessions.
 */
export const MERGE_LAYERS_STORAGE_KEY = 'ifc-lite-merge-layers';

/**
 * Resolve the initial value of the merge-layers toggle from
 * localStorage. Default `false` matches the IFC-Lite WASM default
 * — toggling the UI without ever loading a model is a no-op.
 */
function getInitialMergeLayers(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return localStorage.getItem(MERGE_LAYERS_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * localStorage key for the geometry-worker-count A/B override.
 */
export const GEOM_WORKERS_STORAGE_KEY = 'ifc-lite-geom-workers';
export const GEOM_TIER_STORAGE_KEY = 'ifc-lite-geom-tier';

/**
 * localStorage key for the source-decoupled mesh-only cache KILL SWITCH. The
 * tier is on by default; this key holds `'0'` only when the user disabled it via
 * `?meshCache=0` (absent = default on). See `isMeshOnlyCacheEnabled`.
 */
export const MESH_ONLY_CACHE_STORAGE_KEY = 'ifc-lite-mesh-cache';

// Auto-low tessellation density for heavy models. The on-screen load already
// skips tiny detail boolean cuts on every load (#1286), which removes the
// exact-tier escalations that dominate boolean-heavy steel; this is the
// ORTHOGONAL triangle-count lever — dropping vertex density (low = 0.5x,
// lowest = 0.25x) so a multi-million-triangle model uploads + fits in GPU
// memory fast for first paint. The signal is file size, the only model-weight
// proxy available before geometry runs (the pre-pass job count arrives after
// the cache key is committed). Size correlates with triangle count at scale but
// can't tell a dense-but-small model (e.g. 20 MB detailed steel, ~8M tris) from
// a light one — those still load at medium density (the skip keeps them fast),
// or can be forced low via `?geomTier=low`. Thresholds are deliberately high so
// normal models keep full curve density; tune here.
export const AUTO_LOW_TIER_MB = 50; // >= this → 'low'
export const AUTO_LOWEST_TIER_MB = 150; // >= this → 'lowest'

/** localStorage key for the load-time geometry fidelity mode (mirrors merge-layers). */
export const GEOMETRY_MODE_STORAGE_KEY = 'ifc-lite-geometry-mode';

/**
 * Load-time geometry fidelity mode — a user-facing, persistent switch that
 * mirrors the merge-layers load-time input (sticky in localStorage, folded into
 * the geometry cache key, reload-to-apply).
 * - `fast` (default): skip tiny detail boolean cuts (#1286) + auto-low
 *   tessellation density for heavy models, for fast first paint. PREVIEW
 *   fidelity — sub-10% cutters (bolt holes, copes) are dropped and curves may be
 *   coarser; display, measure AND export all read this same geometry, so it is a
 *   deliberate, visible choice rather than a silent default.
 * - `exact`: full boolean cuts + full curve density everywhere — display,
 *   measure and export consistent. Slower on boolean-heavy / dense models.
 */
export type GeometryMode = 'fast' | 'exact';

/** Resolve the initial geometry mode from localStorage; default `fast`. */
function getInitialGeometryMode(): GeometryMode {
  if (typeof window === 'undefined') return 'fast';
  try {
    return localStorage.getItem(GEOMETRY_MODE_STORAGE_KEY) === 'exact' ? 'exact' : 'fast';
  } catch {
    return 'fast';
  }
}

/**
 * Resolve an explicit geometry-worker count override for A/B tuning, or
 * `undefined` to use the engine's cores/memory heuristic.
 *
 * The optimal worker count is hardware-specific (thermal throttle on fanless
 * laptops vs sustained throughput on actively-cooled Pro/Max machines), so the
 * only honest way to find a host's sweet spot is to measure it. `?geomWorkers=N`
 * in the URL sets the override AND persists it to localStorage, so it survives
 * the reload that re-measuring a model requires (and a shared link carries it).
 * `?geomWorkers=0` (or `auto`) clears the override. The engine still clamps the
 * value to the memory budget — see `computeWorkerCount` — so this can't OOM.
 *
 * Sanity-bounded to [1, 16]; anything outside is ignored.
 */
export function getGeomWorkerOverride(): number | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const param = new URLSearchParams(window.location.search).get('geomWorkers');
    if (param != null) {
      if (param === '0' || param === 'auto') {
        localStorage.removeItem(GEOM_WORKERS_STORAGE_KEY);
        return undefined;
      }
      const n = Number.parseInt(param, 10);
      if (Number.isFinite(n) && n >= 1 && n <= 16) {
        localStorage.setItem(GEOM_WORKERS_STORAGE_KEY, String(n));
        return n;
      }
    }
    const stored = Number.parseInt(localStorage.getItem(GEOM_WORKERS_STORAGE_KEY) ?? '', 10);
    if (Number.isFinite(stored) && stored >= 1 && stored <= 16) return stored;
  } catch {
    /* SSR / blocked storage — fall through to the heuristic */
  }
  return undefined;
}

const TESSELLATION_TIERS: readonly TessellationQuality[] = [
  'lowest',
  'low',
  'medium',
  'high',
  'highest',
];

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
    // bad URL — fall back to the heuristic, but don't swallow silently
    // (AGENTS.md: no silent catch). A persisted ?geomTier override is lost here.
    console.warn('[geom-tier] override read failed; using heuristic', err);
  }
  return undefined;
}

/**
 * Pure decision for the source-decoupled mesh-only cache tier, split out for
 * node:test (the outer {@link isMeshOnlyCacheEnabled} reads `window`/
 * `localStorage`). Default ON — the tier is unflagged for 150-400MB files. The
 * kill switch is `?meshCache=0` (persisted so it sticks across reloads and rides
 * a shared link); `?meshCache=1` clears the kill switch back to the default.
 *
 * @param param  the `meshCache` URL query value, or `null` if absent
 * @param stored the persisted `MESH_ONLY_CACHE_STORAGE_KEY` value, or `null`
 * @returns `enabled` plus the persistence side-effect the caller should apply
 *   (`persist: '0'` writes the kill switch; `clear: true` removes it).
 */
export function resolveMeshCacheDecision(
  param: string | null,
  stored: string | null,
): { enabled: boolean; persist?: '0'; clear?: boolean } {
  if (param === '0' || param === 'false' || param === 'off') {
    return { enabled: false, persist: '0' };
  }
  if (param === '1' || param === 'true' || param === 'on') {
    return { enabled: true, clear: true };
  }
  // Default ON unless the kill switch was persisted.
  return { enabled: stored !== '0' };
}

/**
 * Is the source-decoupled mesh-only cache tier enabled? It caches tables +
 * geometry + instanced shards WITHOUT the source buffer for large (150-400MB)
 * files so REPEAT opens skip the 10-90s parse+mesh. ON BY DEFAULT — the kill
 * switch `?meshCache=0` disables it (persisted to localStorage so it sticks
 * across the reload a re-measure needs, and a shared link carries it);
 * `?meshCache=1` clears the kill switch. The <=150MB source-persisting tier is
 * unaffected either way (it never consults this flag).
 */
export function isMeshOnlyCacheEnabled(): boolean {
  if (typeof window === 'undefined') return false; // SSR never runs the cache path
  const param = new URLSearchParams(window.location.search).get('meshCache');
  try {
    const stored = localStorage.getItem(MESH_ONLY_CACHE_STORAGE_KEY);
    const decision = resolveMeshCacheDecision(param, stored);
    if (decision.persist) localStorage.setItem(MESH_ONLY_CACHE_STORAGE_KEY, decision.persist);
    else if (decision.clear) localStorage.removeItem(MESH_ONLY_CACHE_STORAGE_KEY);
    return decision.enabled;
  } catch (err) {
    // Blocked/unavailable storage (Safari private mode): can't read or persist
    // the kill switch, but an explicit `?meshCache=0` in the URL must STILL
    // disable the tier for this load; otherwise fall back to default-on. Don't
    // swallow silently (AGENTS.md: no silent catch).
    console.warn('[mesh-cache] storage unavailable; honouring URL param, else default-on', err);
    return resolveMeshCacheDecision(param, null).enabled;
  }
}

/**
 * Resolve the load-time tessellation tier for a model of `fileSizeMB` under the
 * given geometry `mode`: a manual `?geomTier=` override wins in any mode; else
 * in `fast` mode auto-low for heavy models by size; else `undefined` (engine
 * default = medium, full curve density). In `exact` mode auto-low never fires,
 * so dense models keep full density. Returning `undefined` at the medium default
 * keeps pre-existing cache entries valid (the tier discriminator is omitted from
 * the cache key at medium — see `buildGeometryCacheKey`).
 */
export function resolveLoadTessellationTier(
  fileSizeMB: number,
  mode: GeometryMode = 'fast'
): TessellationQuality | undefined {
  const override = getGeomTierOverride();
  if (override) return override;
  if (mode !== 'fast') return undefined;
  if (fileSizeMB >= AUTO_LOWEST_TIER_MB) return 'lowest';
  if (fileSizeMB >= AUTO_LOW_TIER_MB) return 'low';
  return undefined;
}

/**
 * localStorage key for the desktop toolbar style (issue #1686). `classic`
 * is the original single-strip toolbar; `ribbon` is the tabbed,
 * IFCFlux-style ribbon. Same sticky-preference pattern as the theme.
 */
export const TOOLBAR_STYLE_STORAGE_KEY = 'ifc-lite-toolbar-style';

export type ToolbarStyle = 'classic' | 'ribbon';

/** Resolve the initial toolbar style from localStorage; default `classic`. */
function getInitialToolbarStyle(): ToolbarStyle {
  if (typeof window === 'undefined') return 'classic';
  try {
    return localStorage.getItem(TOOLBAR_STYLE_STORAGE_KEY) === 'ribbon' ? 'ribbon' : 'classic';
  } catch (err) {
    // Blocked storage (Safari private mode): fall back to the default so the
    // toolbar still renders, but say why the preference didn't stick.
    console.warn('[toolbar-style] storage unavailable; using classic', err);
    return 'classic';
  }
}

/** localStorage key for the ribbon's collapsed state (tab strip only). */
export const RIBBON_COLLAPSED_STORAGE_KEY = 'ifc-lite-ribbon-collapsed';

/** Resolve the initial ribbon collapsed state from localStorage; default expanded. */
function getInitialRibbonCollapsed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return localStorage.getItem(RIBBON_COLLAPSED_STORAGE_KEY) === 'true';
  } catch (err) {
    console.warn('[ribbon-collapsed] storage unavailable; using expanded', err);
    return false;
  }
}

export const UI_DEFAULTS = {
  /** Default active tool */
  ACTIVE_TOOL: 'select',
  /** Default theme – respects user's OS colour-scheme preference */
  THEME: getInitialTheme(),
  /** Default hover tooltips state */
  HOVER_TOOLTIPS_ENABLED: false,
  /** Global visual enhancement kill switch */
  VISUAL_ENHANCEMENTS_ENABLED: true,
  /** Edge contrast enhancement default */
  EDGE_CONTRAST_ENABLED: true,
  /** Edge contrast intensity */
  EDGE_CONTRAST_INTENSITY: 1.2,
  /** Contact shading quality preset */
  CONTACT_SHADING_QUALITY: 'low' as const,
  /** Contact shading intensity */
  CONTACT_SHADING_INTENSITY: 0.35,
  /** Contact shading radius in pixels */
  CONTACT_SHADING_RADIUS: 1.5,
  /** Separation-line overlay default */
  SEPARATION_LINES_ENABLED: true,
  /** Separation-line quality preset */
  SEPARATION_LINES_QUALITY: 'low' as const,
  /** Separation-line intensity */
  SEPARATION_LINES_INTENSITY: 0.38,
  /** Separation-line radius in pixels */
  SEPARATION_LINES_RADIUS: 1.0,
  /**
   * Issue #540: load-time toggle that asks the WASM geometry engine
   * to merge Revit-style multilayer walls into a single solid. Read
   * from localStorage on boot so the user's preference survives
   * reloads. Default `false` keeps existing per-layer rendering.
   */
  MERGE_LAYERS: getInitialMergeLayers(),
  /**
   * Load-time geometry fidelity mode (see `GeometryMode`). Read from
   * localStorage on boot so the user's choice survives reloads. Default `fast`
   * (skip tiny cuts + auto-low density for heavy models) for quick first paint;
   * `exact` for full display/measure/export fidelity.
   */
  GEOMETRY_MODE: getInitialGeometryMode(),
  /**
   * Desktop toolbar style (issue #1686): `classic` single strip or the
   * tabbed `ribbon`. Read from localStorage on boot so the choice
   * survives reloads.
   */
  TOOLBAR_STYLE: getInitialToolbarStyle(),
  /** Ribbon band collapsed to the tab strip only. */
  RIBBON_COLLAPSED: getInitialRibbonCollapsed(),
} as const;

// ============================================================================
// Type Visibility Defaults
// ============================================================================

/**
 * localStorage keys for the type-visibility toggles. Each maps to a
 * single boolean preference; same persistence pattern as
 * `MERGE_LAYERS_STORAGE_KEY` (`'true'` / `'false'` string, anything
 * else falls back to the semantic default). One key per toggle so a
 * user can clear an individual preference without nuking the rest.
 */
export const TYPE_VISIBILITY_STORAGE_KEYS = {
  spaces:          'ifc-lite-ifc-spaces-visible',
  spatialZones:    'ifc-lite-ifc-spatial-zones-visible',
  openings:        'ifc-lite-ifc-openings-visible',
  virtualElements: 'ifc-lite-ifc-virtual-elements-visible',
  site:            'ifc-lite-ifc-site-visible',
  ifcAnnotations:  'ifc-lite-ifc-annotations-visible',
  ifcGrid:         'ifc-lite-ifc-grid-visible',
} as const;

/** Legacy alias — kept until external callers migrate. */
export const IFC_ANNOTATIONS_STORAGE_KEY = TYPE_VISIBILITY_STORAGE_KEYS.ifcAnnotations;

function readPersistedBool(key: string, fallback: boolean): boolean {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(key);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return fallback;
  } catch {
    return fallback;
  }
}

// Semantic defaults applied when no localStorage preference is set.
// IfcSpace / IfcOpeningElement off — they cover walls and confuse novices
// on first load. IfcSite + IfcAnnotation + IfcGrid on — all three convey
// design intent users expect to see by default. (Issue #862 split grid
// into its own toggle so dense-grid models can hide grids without losing
// dimensions/labels.) Exported so the "Reset" action in the visibility
// menu can restore these without re-deriving them.
export const TYPE_VISIBILITY_SEMANTIC_DEFAULTS: TypeVisibility = {
  spaces: false,
  spatialZones: false,
  openings: false,
  // IfcVirtualElement off — non-physical clearance/boundary volumes that
  // obscure real geometry when present (issue #1133).
  virtualElements: false,
  site: true,
  ifcAnnotations: true,
  ifcGrid: true,
};

/**
 * Resolve the full type-visibility preference set from localStorage.
 *
 * Read fresh on EVERY call — not captured once at module load. The store
 * applies this both at boot (slice init) and on every new-file load
 * (`resetViewerState`). A module-level constant would snapshot localStorage
 * at first import and then go stale after the first in-session toggle, so
 * loading a second model would silently revert the user's choices (e.g.
 * "Show Annotations" flipping back on). Reading live keeps every toggle
 * sticky across reloads AND across model swaps within a session.
 */
export function getPersistedTypeVisibility(): TypeVisibility {
  return {
    spaces:          readPersistedBool(TYPE_VISIBILITY_STORAGE_KEYS.spaces, TYPE_VISIBILITY_SEMANTIC_DEFAULTS.spaces),
    spatialZones:    readPersistedBool(TYPE_VISIBILITY_STORAGE_KEYS.spatialZones, TYPE_VISIBILITY_SEMANTIC_DEFAULTS.spatialZones),
    openings:        readPersistedBool(TYPE_VISIBILITY_STORAGE_KEYS.openings, TYPE_VISIBILITY_SEMANTIC_DEFAULTS.openings),
    virtualElements: readPersistedBool(TYPE_VISIBILITY_STORAGE_KEYS.virtualElements, TYPE_VISIBILITY_SEMANTIC_DEFAULTS.virtualElements),
    site:            readPersistedBool(TYPE_VISIBILITY_STORAGE_KEYS.site, TYPE_VISIBILITY_SEMANTIC_DEFAULTS.site),
    ifcAnnotations: readPersistedBool(TYPE_VISIBILITY_STORAGE_KEYS.ifcAnnotations, TYPE_VISIBILITY_SEMANTIC_DEFAULTS.ifcAnnotations),
    // Issue #862. Migration: if the new grid key isn't set yet, fall back to
    // the legacy combined `ifcAnnotations` preference so a user who turned
    // the old "Annotations & Grids" toggle off keeps grids hidden after
    // upgrade instead of grids silently reappearing (PR #868 review).
    ifcGrid:        readPersistedBool(
      TYPE_VISIBILITY_STORAGE_KEYS.ifcGrid,
      readPersistedBool(TYPE_VISIBILITY_STORAGE_KEYS.ifcAnnotations, TYPE_VISIBILITY_SEMANTIC_DEFAULTS.ifcGrid),
    ),
  };
}

/**
 * The 3D view mode for the Model/Types switch (#957 follow-up).
 *   'model' — show placed occurrences (the default; the building as designed).
 *   'types' — show the type-library shapes (each IfcTypeProduct's
 *             RepresentationMap at its MappingOrigin), hiding occurrences.
 * Orphan type geometry (a type with no occurrence, e.g. annex-E showcase files)
 * shows in BOTH modes since it is the only geometry the file has.
 */
export type TypeViewMode = 'model' | 'types';

export const TYPE_VIEW_MODE_STORAGE_KEY = 'ifc-lite-type-view-mode';
export const TYPE_VIEW_MODE_DEFAULT: TypeViewMode = 'model';

/** Resolve the persisted Model/Types view mode (read fresh, like type visibility). */
export function getPersistedTypeViewMode(): TypeViewMode {
  if (typeof window === 'undefined') return TYPE_VIEW_MODE_DEFAULT;
  try {
    return localStorage.getItem(TYPE_VIEW_MODE_STORAGE_KEY) === 'types' ? 'types' : 'model';
  } catch {
    return TYPE_VIEW_MODE_DEFAULT;
  }
}

// ============================================================================
// Data Defaults
// ============================================================================

export const DATA_DEFAULTS = {
  /** Default origin shift (no shift) */
  ORIGIN_SHIFT: { x: 0, y: 0, z: 0 },
  /** Default large coordinates state (false = normal coordinates, no RTC needed) */
  HAS_LARGE_COORDINATES: false,
} as const;
