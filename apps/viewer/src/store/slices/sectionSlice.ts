/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Section plane state slice
 */

import type { StateCreator } from 'zustand';
import type { SectionPlane, SectionPlaneAxis, SectionCapStyle, SectionCapHatchId } from '../types.js';
import { SECTION_PLANE_DEFAULTS, SECTION_CAP_DEFAULTS } from '../constants.js';

// ─── Persistence ─────────────────────────────────────────────────────────
// Cap appearance (hatch pattern, colours, spacing, angle, whether the cap is
// shown at all) persists across reloads via localStorage, so the user's
// preferred cut surface survives closing and re-opening the app. Axis and
// position are session-scoped because they only make sense relative to a
// loaded model. See chatSlice.ts for the same direct-localStorage pattern
// used elsewhere in the store.
const CAP_STYLE_STORAGE_KEY     = 'ifc-lite:section-cap-style';
const CAP_SHOW_STORAGE_KEY      = 'ifc-lite:section-cap-show';
const OUTLINES_SHOW_STORAGE_KEY = 'ifc-lite:section-outlines-show';

const HATCH_IDS: readonly SectionCapHatchId[] = [
  'solid', 'diagonal', 'crossHatch', 'horizontal',
  'vertical', 'concrete', 'brick', 'insulation',
] as const;

function isHatchId(v: unknown): v is SectionCapHatchId {
  return typeof v === 'string' && (HATCH_IDS as readonly string[]).includes(v);
}

function isRgba(v: unknown): v is [number, number, number, number] {
  return Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
}

function loadCapStyle(): SectionCapStyle {
  const fallback: SectionCapStyle = {
    fillColor:   [...SECTION_CAP_DEFAULTS.FILL_COLOR],
    strokeColor: [...SECTION_CAP_DEFAULTS.STROKE_COLOR],
    pattern:     SECTION_CAP_DEFAULTS.PATTERN,
    spacingPx:   SECTION_CAP_DEFAULTS.SPACING_PX,
    angleRad:    SECTION_CAP_DEFAULTS.ANGLE_RAD,
    widthPx:     SECTION_CAP_DEFAULTS.WIDTH_PX,
    secondaryAngleRad: SECTION_CAP_DEFAULTS.SECONDARY_ANGLE_RAD,
  };
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(CAP_STYLE_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      fillColor:   isRgba(parsed.fillColor)   ? parsed.fillColor   : fallback.fillColor,
      strokeColor: isRgba(parsed.strokeColor) ? parsed.strokeColor : fallback.strokeColor,
      pattern:     isHatchId(parsed.pattern)  ? parsed.pattern     : fallback.pattern,
      spacingPx:   typeof parsed.spacingPx === 'number' && Number.isFinite(parsed.spacingPx)
        ? Math.max(2, parsed.spacingPx) : fallback.spacingPx,
      angleRad:    typeof parsed.angleRad === 'number' && Number.isFinite(parsed.angleRad)
        ? parsed.angleRad : fallback.angleRad,
      widthPx:     typeof parsed.widthPx === 'number' && Number.isFinite(parsed.widthPx)
        ? Math.max(1, parsed.widthPx) : fallback.widthPx,
      secondaryAngleRad: typeof parsed.secondaryAngleRad === 'number' && Number.isFinite(parsed.secondaryAngleRad)
        ? parsed.secondaryAngleRad : fallback.secondaryAngleRad,
    };
  } catch (error) {
    console.warn('[section] failed to load cap style from localStorage', error);
    return fallback;
  }
}

function saveCapStyle(style: SectionCapStyle): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(CAP_STYLE_STORAGE_KEY, JSON.stringify(style));
  } catch (error) {
    // Storage quota, private mode etc. — preference just doesn't persist this
    // session; log so a missing setting is at least diagnosable in devtools.
    console.warn('[section] failed to save cap style to localStorage', error);
  }
}

function loadBoolean(key: string, fallback: boolean): boolean {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
  } catch (error) {
    console.warn(`[section] failed to load preference '${key}' from localStorage`, error);
  }
  return fallback;
}

function saveBoolean(key: string, value: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, String(value));
  } catch (error) {
    console.warn(`[section] failed to save preference '${key}' to localStorage`, error);
  }
}

const loadShowCap      = () => loadBoolean(CAP_SHOW_STORAGE_KEY,      SECTION_PLANE_DEFAULTS.SHOW_CAP);
const saveShowCap      = (v: boolean) => saveBoolean(CAP_SHOW_STORAGE_KEY,      v);
const loadShowOutlines = () => loadBoolean(OUTLINES_SHOW_STORAGE_KEY, SECTION_PLANE_DEFAULTS.SHOW_OUTLINES);
const saveShowOutlines = (v: boolean) => saveBoolean(OUTLINES_SHOW_STORAGE_KEY, v);

export interface SectionSlice {
  // State
  sectionPlane: SectionPlane;

  // Actions
  setSectionPlaneAxis: (axis: SectionPlaneAxis) => void;
  setSectionPlanePosition: (position: number) => void;
  toggleSectionPlane: () => void;
  setSectionPlaneEnabled: (enabled: boolean) => void;
  flipSectionPlane: () => void;
  setSectionShowCap: (show: boolean) => void;
  setSectionShowOutlines: (show: boolean) => void;
  setSectionCapStyle: (style: Partial<SectionCapStyle>) => void;
  resetSectionPlane: () => void;
}

const getDefaultCapStyle = (): SectionCapStyle => loadCapStyle();

const getDefaultSectionPlane = (): SectionPlane => ({
  axis: SECTION_PLANE_DEFAULTS.AXIS,
  position: SECTION_PLANE_DEFAULTS.POSITION,
  enabled: SECTION_PLANE_DEFAULTS.ENABLED,
  flipped: SECTION_PLANE_DEFAULTS.FLIPPED,
  // showCap + showOutlines + capStyle come from localStorage so the
  // user's preferred cut-surface appearance survives reloads; the axis,
  // position, and enabled fields stay session-scoped because they only
  // make sense for the currently loaded model.
  showCap:      loadShowCap(),
  showOutlines: loadShowOutlines(),
  capStyle:     getDefaultCapStyle(),
});

export const createSectionSlice: StateCreator<SectionSlice, [], [], SectionSlice> = (set) => ({
  // Initial state
  sectionPlane: getDefaultSectionPlane(),

  // Actions
  setSectionPlaneAxis: (axis) => set((state) => ({
    // Changing the axis implicitly means "I want to cut now" — enable the clip
    // so users don't get stuck in a confusing no-op preview.
    sectionPlane: { ...state.sectionPlane, axis, enabled: true },
  })),

  setSectionPlanePosition: (position) => set((state) => {
    // Clamp position to valid range [0, 100]
    const clampedPosition = Math.min(100, Math.max(0, Number(position) || 0));
    return {
      // Moving the slider also enables the cut — previously you had to press
      // "Cutting" separately, which led to the "it just jitters, doesn't cut"
      // feedback from users.
      sectionPlane: { ...state.sectionPlane, position: clampedPosition, enabled: true },
    };
  }),

  toggleSectionPlane: () => set((state) => ({
    sectionPlane: { ...state.sectionPlane, enabled: !state.sectionPlane.enabled },
  })),

  setSectionPlaneEnabled: (enabled) => set((state) => ({
    sectionPlane: { ...state.sectionPlane, enabled },
  })),

  flipSectionPlane: () => set((state) => ({
    sectionPlane: { ...state.sectionPlane, flipped: !state.sectionPlane.flipped },
  })),

  setSectionShowCap: (showCap) => set((state) => {
    saveShowCap(showCap);
    return { sectionPlane: { ...state.sectionPlane, showCap } };
  }),

  setSectionShowOutlines: (showOutlines) => set((state) => {
    saveShowOutlines(showOutlines);
    return { sectionPlane: { ...state.sectionPlane, showOutlines } };
  }),

  setSectionCapStyle: (style) => set((state) => {
    const capStyle: SectionCapStyle = { ...state.sectionPlane.capStyle, ...style };
    saveCapStyle(capStyle);
    return { sectionPlane: { ...state.sectionPlane, capStyle } };
  }),

  resetSectionPlane: () => set(() => {
    // Reset clears persisted cap style too — users asking for defaults expect
    // the defaults to stick on the next reload.
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.removeItem(CAP_STYLE_STORAGE_KEY);
        window.localStorage.removeItem(CAP_SHOW_STORAGE_KEY);
        window.localStorage.removeItem(OUTLINES_SHOW_STORAGE_KEY);
      }
    } catch (error) {
      console.warn('[section] failed to clear persisted cap preferences', error);
    }
    return { sectionPlane: getDefaultSectionPlane() };
  }),
});
