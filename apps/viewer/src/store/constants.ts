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
  /** Default enabled state */
  ENABLED: true,
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
} as const;

// ============================================================================
// Type Visibility Defaults
// ============================================================================

export const TYPE_VISIBILITY_DEFAULTS = {
  /** IfcSpace visibility - off by default */
  SPACES: false,
  /** IfcOpeningElement visibility - off by default */
  OPENINGS: false,
  /** IfcSite visibility - on by default (when has geometry) */
  SITE: true,
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
