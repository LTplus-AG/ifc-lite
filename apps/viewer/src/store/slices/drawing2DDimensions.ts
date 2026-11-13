/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Linear dimensions on the 2D drawing panel: the markup kind's data model,
 * its store actions and its persisted-shape validator.
 *
 * Lives beside `drawing2DSlice.ts` (as `drawing2DSlice.dxfActions.ts` does)
 * because that slice is held to a module-size budget
 * (`scripts/module-size-allowlist.txt`). The slice spreads
 * {@link createDimension2DActions} and {@link getDefaultDimension2DState} and
 * delegates its delete and move cases to {@link moveDimension2D}.
 *
 * A dimension stores only what the user placed: the two measured points, the
 * signed offset of the dimension line and its orientation. The measured value
 * is always derived (`lib/drawing2d-markup/dimension-graphics.ts`), never
 * stored, so a stored value can never disagree with the drawn geometry.
 */

import type { StateCreator } from 'zustand';
import type { Drawing2DSlice, DrawnSectionPlane, Point2D } from './drawing2DSlice';
import { isFiniteNumber, isPoint2D } from './drawing2DSlice.markupValidation.js';
import { isDegenerateMeasurement } from './drawing2DDegenerateGuards';
import { customPlaneCenter } from './section-plane-center';

/** The IFC element a measured point was snapped to. */
export interface Dimension2DElementRef {
  globalId: string;
  ifcType: string;
}

/** How the dimension line runs: along a→b, or locked to the drawing's x or y axis. */
export type Dimension2DOrientation = 'aligned' | 'horizontal' | 'vertical';

export const DIMENSION_2D_ORIENTATIONS: readonly Dimension2DOrientation[] = ['aligned', 'horizontal', 'vertical'];

/** A snapped linear dimension. */
export interface Dimension2D {
  id: string;
  /** Measured points, in drawing metres before any section flip (the same space as `Measure2DResult`). */
  a: Point2D;
  b: Point2D;
  /**
   * Signed distance in metres from the measured points to the dimension line,
   * along the left-hand normal of the line direction (aligned: a→b; horizontal:
   * +x; vertical: +y), measured from the midpoint of a and b.
   */
  offset: number;
  orientation: Dimension2DOrientation;
  /** Text override; every `<>` stands for the measured value. */
  text?: string;
  refs?: { a?: Dimension2DElementRef; b?: Dimension2DElementRef };
  /** The cut the dimension was drawn on (`drawing2DPlane` at creation). */
  plane?: DrawnSectionPlane;
}

export interface Dimension2DState {
  /** Placed dimensions. */
  dimensions2D: Dimension2D[];
  /** Measured points placed so far for the in-progress dimension (0-2). */
  dimension2DPoints: Point2D[];
}

/** What the tool supplies when it places the dimension line; the points come from `dimension2DPoints`. */
export type Dimension2DPlacement = Pick<Dimension2D, 'offset' | 'orientation' | 'text' | 'refs' | 'plane'>;

export interface Dimension2DActions {
  addDimension2D: (dimension: Dimension2D) => void;
  updateDimension2D: (id: string, updates: Partial<Omit<Dimension2D, 'id'>>) => void;
  removeDimension2D: (id: string) => void;
  addDimension2DPoint: (point: Point2D) => void;
  /** Turn the two placed points into a dimension. Returns its id, or `null` when there are not two points or the measured value is degenerate; the in-progress points are cleared either way. */
  completeDimension2D: (placement: Dimension2DPlacement) => string | null;
  cancelDimension2D: () => void;
  clearDimensions2D: () => void;
}

export function getDefaultDimension2DState(): Dimension2DState {
  return { dimensions2D: [], dimension2DPoints: [] };
}

/** The value a dimension measures, in metres: the a→b distance projected onto its orientation. */
export function measuredDimensionValue(dim: Pick<Dimension2D, 'a' | 'b' | 'orientation'>): number {
  const dx = dim.b.x - dim.a.x;
  const dy = dim.b.y - dim.a.y;
  if (dim.orientation === 'horizontal') return Math.abs(dx);
  if (dim.orientation === 'vertical') return Math.abs(dy);
  return Math.hypot(dx, dy);
}

/**
 * Move `id` so its first measured point lands on `newOrigin` (the drag
 * contract of `moveAnnotation2D`): `a` and `b` translate together, the offset
 * is relative to them and stays as it is. Returns `dimensions` unchanged when
 * `id` is absent.
 */
export function moveDimension2D(dimensions: Dimension2D[], id: string, newOrigin: Point2D): Dimension2D[] {
  const dim = dimensions.find((d) => d.id === id);
  if (!dim) return dimensions;
  const dx = newOrigin.x - dim.a.x;
  const dy = newOrigin.y - dim.a.y;
  return dimensions.map((d) => (d.id === id
    ? { ...d, a: { x: d.a.x + dx, y: d.a.y + dy }, b: { x: d.b.x + dx, y: d.b.y + dy } }
    : d));
}

/** A copy of just the plane fields a dimension keeps, so a live `SectionPlane` passed in never leaks its id or name into storage. */
export function dimensionPlaneStamp(plane: DrawnSectionPlane | null | undefined): DrawnSectionPlane | undefined {
  if (!plane) return undefined;
  return {
    axis: plane.axis,
    position: plane.position,
    flipped: plane.flipped,
    ...(plane.custom ? { custom: structuredClone(plane.custom) } : {}),
  };
}

const PLANE_EPS = 1e-6;
const near = (p: number, q: number) => Math.abs(p - q) <= PLANE_EPS;
type CustomPlane = NonNullable<DrawnSectionPlane['custom']>;
const isVec3 = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every(isFiniteNumber);
const dot3 = (u: readonly number[], v: readonly number[]) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];

/**
 * Whether two custom planes put the drawing's 2D frame in the same place: the
 * same in-plane axes, and the frame origin (`customPlaneCenter`, the pick
 * point on the plane) at the same in-plane coordinates. Two picks on one face
 * share normal and distance but not the origin, so the same 2D point lands
 * elsewhere (#10076 review). The origin's normal component is left out:
 * `distance` already covers it. A stamp without the frame fields (an older or
 * imported one) cannot be told apart and matches.
 */
function sameInPlaneFrame(a: CustomPlane, b: CustomPlane): boolean {
  if (![a.pickedAt, a.tangent, a.bitangent, b.pickedAt, b.tangent, b.bitangent].every(isVec3)) return true;
  if (!a.tangent.every((v, i) => near(v, b.tangent[i])) || !a.bitangent.every((v, i) => near(v, b.bitangent[i]))) return false;
  const [ca, cb] = [customPlaneCenter(a), customPlaneCenter(b)];
  return near(dot3(ca, a.tangent), dot3(cb, a.tangent)) && near(dot3(ca, a.bitangent), dot3(cb, a.bitangent));
}

/**
 * Whether `dim` belongs to the cut now drawn (`drawing2DPlane`). A dimension
 * without a stamp, or a panel with no drawn plane, counts as on it: there is
 * nothing to tell them apart by. A custom plane compares by its normal,
 * distance and 2D frame (`sameInPlaneFrame`), a cardinal one by axis and
 * position; the flip must match either way.
 */
export function isDimensionOnPlane(dim: Pick<Dimension2D, 'plane'>, current: DrawnSectionPlane | null | undefined): boolean {
  const stamp = dim.plane;
  if (!stamp || !current) return true;
  if (stamp.flipped !== current.flipped) return false;
  const [sc, cc] = [stamp.custom, current.custom];
  if (sc || cc) {
    if (!sc || !cc) return false;
    return near(sc.distance, cc.distance) && sc.normal.every((v, i) => near(v, cc.normal[i])) && sameInPlaneFrame(sc, cc);
  }
  return stamp.axis === current.axis && near(stamp.position, current.position);
}

/**
 * The dimensions an export may contain: those on the cut now drawn. A
 * dimension from another cut is shown dimmed on screen but left out of every
 * export, since its points need not lie on this drawing's geometry.
 */
export function exportableDimensions(dimensions: readonly Dimension2D[], current: DrawnSectionPlane | null | undefined): Dimension2D[] {
  return dimensions.filter((d) => isDimensionOnPlane(d, current));
}

const isValidPlacement = (dim: Pick<Dimension2D, 'a' | 'b' | 'offset' | 'orientation'>): boolean =>
  isPoint2D(dim.a) && isPoint2D(dim.b) && isFiniteNumber(dim.offset) && DIMENSION_2D_ORIENTATIONS.includes(dim.orientation);

export function createDimension2DActions(
  set: Parameters<StateCreator<Drawing2DSlice>>[0],
  get: Parameters<StateCreator<Drawing2DSlice>>[1],
): Dimension2DActions {
  return {
    addDimension2D: (dimension) => {
      if (!isValidPlacement(dimension)) return;
      set((state) => ({ dimensions2D: [...state.dimensions2D, dimension] }));
    },

    updateDimension2D: (id, updates) => set((state) => ({
      dimensions2D: state.dimensions2D.map((d) => {
        if (d.id !== id) return d;
        const next = { ...d, ...updates };
        return isValidPlacement(next) ? next : d;
      }),
    })),

    removeDimension2D: (id) => set((state) => ({
      dimensions2D: state.dimensions2D.filter((d) => d.id !== id),
      selectedAnnotation2D: state.selectedAnnotation2D?.type === 'dimension' && state.selectedAnnotation2D.id === id
        ? null : state.selectedAnnotation2D,
    })),

    addDimension2DPoint: (point) => set((state) => (
      state.dimension2DPoints.length >= 2 || !isPoint2D(point)
        ? {}
        : { dimension2DPoints: [...state.dimension2DPoints, point] }
    )),

    completeDimension2D: (placement) => {
      const [a, b] = get().dimension2DPoints;
      set({ dimension2DPoints: [], annotation2DCursorPos: null });
      if (!a || !b) return null;
      const dimension: Dimension2D = {
        id: `dimension-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        a,
        b,
        offset: placement.offset,
        orientation: placement.orientation,
        ...(placement.text !== undefined ? { text: placement.text } : {}),
        ...(placement.refs ? { refs: placement.refs } : {}),
        ...(placement.plane ? { plane: dimensionPlaneStamp(placement.plane) } : {}),
      };
      if (!isValidPlacement(dimension) || isDegenerateMeasurement(measuredDimensionValue(dimension))) return null;
      set((state) => ({ dimensions2D: [...state.dimensions2D, dimension] }));
      return dimension.id;
    },

    cancelDimension2D: () => set({ dimension2DPoints: [], annotation2DCursorPos: null }),

    clearDimensions2D: () => set((state) => ({
      dimensions2D: [],
      dimension2DPoints: [],
      selectedAnnotation2D: state.selectedAnnotation2D?.type === 'dimension' ? null : state.selectedAnnotation2D,
    })),
  };
}

// ── Persisted-shape validation ───────────────────────────────────────

function isElementRef(v: unknown): v is Dimension2DElementRef {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r.globalId === 'string' && typeof r.ifcType === 'string';
}

function isTriple(v: unknown): v is [number, number, number] {
  return Array.isArray(v) && v.length === 3 && v.every(isFiniteNumber);
}

function isDrawnSectionPlane(v: unknown): v is DrawnSectionPlane {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  if (typeof p.axis !== 'string' || !isFiniteNumber(p.position) || typeof p.flipped !== 'boolean') return false;
  if (p.custom === undefined) return true;
  if (!p.custom || typeof p.custom !== 'object') return false;
  const c = p.custom as Record<string, unknown>;
  return isTriple(c.normal) && isFiniteNumber(c.distance);
}

/**
 * A stored value the slice can render as a dimension. Optional fields may be
 * absent, but one that is present and malformed rejects the dimension: the
 * loader drops it rather than guess at a reference or cut.
 */
export function isDimension2D(v: unknown): v is Dimension2D {
  if (!v || typeof v !== 'object') return false;
  const d = v as Record<string, unknown>;
  if (typeof d.id !== 'string' || d.id.length === 0) return false;
  if (!isPoint2D(d.a) || !isPoint2D(d.b) || !isFiniteNumber(d.offset)) return false;
  if (typeof d.orientation !== 'string' || !(DIMENSION_2D_ORIENTATIONS as readonly string[]).includes(d.orientation)) return false;
  if (d.text !== undefined && typeof d.text !== 'string') return false;
  if (d.plane !== undefined && !isDrawnSectionPlane(d.plane)) return false;
  if (d.refs !== undefined) {
    if (!d.refs || typeof d.refs !== 'object') return false;
    const refs = d.refs as Record<string, unknown>;
    if (refs.a !== undefined && !isElementRef(refs.a)) return false;
    if (refs.b !== undefined && !isElementRef(refs.b)) return false;
  }
  return true;
}

/** The stored `dimensions2D` field of a persisted entry, tolerating its absence (entries saved before dimensions existed). */
export function loadPersistedDimensions(v: unknown): Dimension2D[] {
  return Array.isArray(v) ? v.filter(isDimension2D) : [];
}
