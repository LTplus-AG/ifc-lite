/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Section plane state slice
 */

import type { StateCreator } from 'zustand';
import type { SectionPlane, SectionPlaneAxis, SectionCapStyle, SectionCapHatchId, CustomSectionPlane } from '../types.js';
import { SECTION_PLANE_DEFAULTS, SECTION_CAP_DEFAULTS } from '../constants.js';
import { planeBasis, nearestCardinalAxis } from '@ifc-lite/renderer';

/**
 * Project `pickedAt` onto the current cut plane and return that point as
 * the "anchor on the live plane".
 *
 * The plane equation is `dot(p, normal) = distance`. As the user drags
 * the gizmo (or moves the slider) only `distance` changes — `pickedAt`
 * stays at the original face-pick location, which sits OFF the live
 * plane. Any visual that needs a "point on the current plane" (cap
 * polygon basis origin, 3D drag gizmo position, hatch UV anchor) must
 * use the projected point instead, otherwise it freezes at the original
 * pick location while the actual cut slides along the normal.
 *
 * Derivation: the projection of `pickedAt` onto the plane is
 * `pickedAt + (distance − dot(pickedAt, normal)) · normal`, which moves
 * `pickedAt` along the unit normal by exactly the offset required to
 * satisfy `dot(out, normal) = distance`.
 *
 * Round-trip note: when `distance == dot(pickedAt, normal)` (i.e. just
 * after a fresh face-pick) the result equals `pickedAt`, so the legacy
 * code path that fed `pickedAt` directly is preserved at pick-time.
 */
export function customPlaneCenter(plane: CustomSectionPlane): [number, number, number] {
  const { pickedAt: p, normal: n, distance: d } = plane;
  const dotPicked = p[0] * n[0] + p[1] * n[1] + p[2] * n[2];
  const k = d - dotPicked;
  return [p[0] + k * n[0], p[1] + k * n[1], p[2] + k * n[2]];
}

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

/**
 * Live "where will I cut if you click here?" preview, set by the hover
 * dwell handler in `useMouseControls.ts` while `sectionPickMode` is on.
 *
 * `normal` is camera-oriented (matches the face-pick commit policy in
 * `selectionHandlers.ts`) so the preview's arrow points in the same
 * direction the actual cut will keep, and the user sees a visually
 * continuous transition on click. `point` is the world-space hit
 * location. `faceKey` is used by the hover handler to detect "still on
 * the same face" so cursor wobble within a flat surface doesn't
 * retrigger the dwell timer or repaint the overlay.
 */
export interface SectionPickPreview {
  normal:  [number, number, number];
  point:   [number, number, number];
  faceKey: string;
}

export interface SectionSlice {
  // State
  sectionPlane: SectionPlane;
  /**
   * When true, the next click on the canvas picks a face and sets the
   * section plane through it (world-space normal + point). Cleared after
   * one pick, a missed click, or a tool change. See
   * `selectionHandlers.ts` for the consumer.
   */
  sectionPickMode: boolean;
  /**
   * Hover preview for the face-pick gesture (issue #243 follow-up).
   * Populated by the dwell handler when the cursor pauses ~200ms over a
   * surface; consumed by `SectionVisualization.tsx` to paint a
   * translucent violet quad + a tiny normal arrow on the hovered face.
   * Cleared on cursor leaving the canvas, moving to a different face,
   * disarming pick mode, or successful commit.
   */
  sectionPickPreview: SectionPickPreview | null;

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
  /**
   * Set the section plane from a face pick. `normal` is the face's world-
   * space unit normal; `point` is any point on the face (typically the
   * raycast hit). The derived plane equation is
   * `dot(worldPos, normal) = dot(point, normal)`.
   *
   * Also writes the nearest cardinal `axis` + `flipped` and a percentage-
   * along-that-axis `position` so legacy consumers (drawings, BCF,
   * tooltips) still see a reasonable axis-aligned approximation.
   */
  setSectionPlaneFromFace: (
    normal: [number, number, number],
    point: [number, number, number],
    bounds?: { min: [number, number, number]; max: [number, number, number] },
  ) => void;
  /** Update only the custom plane's signed distance (drag gizmo / numeric input). */
  setSectionCustomDistance: (distance: number) => void;
  /** Arm/disarm the "next click picks a face" mode. Disarming clears any active hover preview. */
  setSectionPickMode: (enabled: boolean) => void;
  /**
   * Set or clear the live face-pick hover preview. `null` hides the
   * overlay (cursor left the canvas, moved to a new face, or the pick
   * mode was disarmed). Only the dwell-aware hover handler should set
   * this — it is purely a visual hint and does not change `sectionPlane`
   * (commit happens via `setSectionPlaneFromFace` on click).
   */
  setSectionPickPreview: (preview: SectionPickPreview | null) => void;
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
  sectionPickMode: false,
  sectionPickPreview: null,

  // Actions
  setSectionPlaneAxis: (axis) => set((state) => ({
    // Changing the axis implicitly means "I want to cut now" — enable the clip
    // so users don't get stuck in a confusing no-op preview. Also drop any
    // custom (face-picked) plane so the cardinal preset takes over cleanly.
    sectionPlane: { ...state.sectionPlane, axis, enabled: true, custom: undefined },
  })),

  setSectionPlanePosition: (position) => set((state) => {
    // Clamp position to valid range [0, 100]
    const clampedPosition = Math.min(100, Math.max(0, Number(position) || 0));
    // Slider semantics differ between cardinal and custom modes:
    //   • cardinal: percentage along the axis between bounds extents.
    //   • custom: percentage along the picked normal between the bounds-
    //     diagonal extents centred on `pickedAt`. The renderer translates
    //     that to a signed `distance`; the action below just stores the
    //     percentage and updates `custom.distance` to match.
    const next: SectionPlane = { ...state.sectionPlane, position: clampedPosition, enabled: true };
    if (state.sectionPlane.custom) {
      const c = state.sectionPlane.custom;
      // Re-anchor distance from percentage. The half-extent is derived
      // from the renderer-supplied bounds when we have them — at this
      // point in the slice we don't, so we use the existing distance as
      // the anchor and shift it by the percentage delta. This keeps the
      // slider responsive without the slice needing a bounds dependency.
      // The renderer cap path uses `custom.distance` verbatim regardless,
      // so the visual stays accurate.
      const dPct = (clampedPosition - state.sectionPlane.position) / 100;
      const dot = c.pickedAt[0] * c.normal[0] + c.pickedAt[1] * c.normal[1] + c.pickedAt[2] * c.normal[2];
      // 100% of slider span = ~bounds-diagonal; without bounds, fall
      // back to a generous fixed step (10 world units per 100%). The
      // SectionPanel updates this with the real bounds via
      // `setSectionCustomDistance` once they're known.
      const fallbackSpan = 10;
      next.custom = { ...c, distance: c.distance + dPct * fallbackSpan };
      // Keep `pickedAt` so future deltas remain anchored to the original
      // pick — only `distance` (and on flip, `normal`) ever change.
      void dot;
    }
    return { sectionPlane: next };
  }),

  toggleSectionPlane: () => set((state) => ({
    sectionPlane: { ...state.sectionPlane, enabled: !state.sectionPlane.enabled },
  })),

  setSectionPlaneEnabled: (enabled) => set((state) => ({
    sectionPlane: { ...state.sectionPlane, enabled },
  })),

  flipSectionPlane: () => set((state) => {
    // A plane is geometrically defined by `(normal, distance)`. Which
    // half-space is kept is a separate choice expressed by `flipped`.
    // The renderer's clip shader applies `flipped` independently
    // (`side = flipped ? -1 : 1`, then `distToPlane * side`), so toggling
    // the boolean alone is sufficient to swap the visible half-space —
    // for both cardinal and custom planes. Mutating `custom.normal` /
    // `custom.distance` here as well would double-cancel the shader's
    // own flip (negate-and-negate-again leaves the same half-space
    // clipped) and the flip button would have no visible effect.
    return { sectionPlane: { ...state.sectionPlane, flipped: !state.sectionPlane.flipped } };
  }),

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
    return { sectionPlane: getDefaultSectionPlane(), sectionPickMode: false, sectionPickPreview: null };
  }),

  setSectionPlaneFromFace: (normal, point, bounds) => set((state) => {
    const nx = normal[0]; const ny = normal[1]; const nz = normal[2];
    const len = Math.hypot(nx, ny, nz);
    if (!Number.isFinite(len) || len < 1e-6) {
      // Degenerate normal — disarm pick mode but don't poison the
      // renderer with NaNs. Also clear any in-flight hover preview so
      // the violet quad doesn't linger after a bogus pick attempt.
      console.warn('[section] face-pick received a degenerate normal; ignoring');
      return { sectionPickMode: false, sectionPickPreview: null };
    }
    const unit: [number, number, number] = [nx / len, ny / len, nz / len];
    const distance = point[0] * unit[0] + point[1] * unit[1] + point[2] * unit[2];
    const basis = planeBasis(unit);
    const cardinal = nearestCardinalAxis(unit);

    // Re-compute `position` along the chosen cardinal so legacy axis-aligned
    // consumers (drawings export, BCF) get a percentage that lines up with
    // the picked plane rather than whatever slider value was set before.
    // Without `bounds` we keep the previous value (P2 CR comment on PR
    // #581) — the SectionPanel passes bounds when available.
    let position = state.sectionPlane.position;
    if (bounds) {
      const axisIdx = cardinal.axis === 'side' ? 0 : cardinal.axis === 'down' ? 1 : 2;
      const axisMin = bounds.min[axisIdx];
      const axisMax = bounds.max[axisIdx];
      const range = axisMax - axisMin;
      if (range > 1e-6) {
        const along = point[axisIdx];
        position = Math.min(100, Math.max(0,
          ((along - axisMin) / range) * 100,
        ));
      }
    }

    const custom: CustomSectionPlane = {
      normal:    unit,
      distance,
      pickedAt:  [point[0], point[1], point[2]],
      tangent:   basis.tangent,
      bitangent: basis.bitangent,
    };

    return {
      sectionPlane: {
        ...state.sectionPlane,
        axis:    cardinal.axis,
        flipped: cardinal.flipped,
        position,
        enabled: true,
        custom,
      },
      sectionPickMode: false,
      // Commit consumes the preview — the violet quad transitions
      // visually into the actual cap on the next render. Clearing here
      // (rather than waiting for the hover handler) avoids a frame of
      // double-render where both preview and cap paint the same face.
      sectionPickPreview: null,
    };
  }),

  setSectionCustomDistance: (distance) => set((state) => {
    if (!state.sectionPlane.custom || !Number.isFinite(distance)) {
      return state;
    }
    return {
      sectionPlane: {
        ...state.sectionPlane,
        custom: { ...state.sectionPlane.custom, distance },
      },
    };
  }),

  setSectionPickMode: (enabled) => set(() => (
    // Disarming pick mode also drops any hovering preview overlay so
    // it doesn't linger after the user toggles off (Esc, second toggle
    // press, tool change). Re-arming starts fresh.
    enabled
      ? { sectionPickMode: true }
      : { sectionPickMode: false, sectionPickPreview: null }
  )),

  setSectionPickPreview: (preview) => set((state) => {
    // Setting a preview while pick mode is OFF would put the violet
    // quad on screen with no way to commit it — guard against that so
    // a stale hover event firing after disarm doesn't reintroduce the
    // overlay.
    if (preview !== null && !state.sectionPickMode) {
      return state;
    }
    return { sectionPickPreview: preview };
  }),
});
