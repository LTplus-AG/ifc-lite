/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Store constants - extracted magic numbers for maintainability
 */

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
  spaces:         'ifc-lite-ifc-spaces-visible',
  openings:       'ifc-lite-ifc-openings-visible',
  site:           'ifc-lite-ifc-site-visible',
  ifcAnnotations: 'ifc-lite-ifc-annotations-visible',
  ifcGrid:        'ifc-lite-ifc-grid-visible',
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
// dimensions/labels.)
const SEMANTIC_DEFAULTS = {
  spaces: false,
  openings: false,
  site: true,
  ifcAnnotations: true,
  ifcGrid: true,
} as const;

export const TYPE_VISIBILITY_DEFAULTS = {
  /** IfcSpace visibility — persisted across reloads. */
  SPACES:          readPersistedBool(TYPE_VISIBILITY_STORAGE_KEYS.spaces, SEMANTIC_DEFAULTS.spaces),
  /** IfcOpeningElement visibility — persisted across reloads. */
  OPENINGS:        readPersistedBool(TYPE_VISIBILITY_STORAGE_KEYS.openings, SEMANTIC_DEFAULTS.openings),
  /** IfcSite visibility — persisted across reloads. */
  SITE:            readPersistedBool(TYPE_VISIBILITY_STORAGE_KEYS.site, SEMANTIC_DEFAULTS.site),
  /** IfcAnnotation visibility (text, dimensions, leaders) — persisted. */
  IFC_ANNOTATIONS: readPersistedBool(TYPE_VISIBILITY_STORAGE_KEYS.ifcAnnotations, SEMANTIC_DEFAULTS.ifcAnnotations),
  /** IfcGrid visibility (axis lines + bubble tags) — persisted. Issue #862. */
  IFC_GRID:        readPersistedBool(TYPE_VISIBILITY_STORAGE_KEYS.ifcGrid, SEMANTIC_DEFAULTS.ifcGrid),
} as const;

// ============================================================================
// Data Defaults
// ============================================================================

export const DATA_DEFAULTS = {
  /** Default origin shift (no shift) */
  ORIGIN_SHIFT: { x: 0, y: 0, z: 0 },
  /** Default large coordinates state (false = normal coordinates, no RTC needed) */
  HAS_LARGE_COORDINATES: false,
} as const;
