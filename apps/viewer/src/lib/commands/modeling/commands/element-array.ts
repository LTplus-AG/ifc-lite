/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `element.array` (#6232 C3): repeat the selected elements.
 *
 *   - Linear: two clicks give the direction. With Spacing, the distance
 *     between them (or the typed Spacing) is the step from one copy to the
 *     next; with Fit, the whole array spans it.
 *   - Polar: a click sets the centre, a second click (or Enter) writes the
 *     copies turned about it, spread over Angle (360° shares the full turn).
 *
 * Count is the number of items including the original. Every copy is written
 * by the one copy path (`copy-elements.ts`: fresh GlobalIds, hosted openings,
 * doors and windows copied with their host), and the whole array is one
 * transaction, so one undo step. The copies are selected.
 */

import { arrayCopyTransforms, type CopyTransform } from '@ifc-lite/create';
import { ArrayBar } from '@/components/viewer/tools/command/ArrayBar';
import type { TranslationKey } from '@/i18n';
import type { Vec2 } from '@/lib/snap/types';
import { useViewerStore } from '@/store';
import { copyElements, copySources, withHostedFillings } from '../copy-elements.js';
import { selectedElements } from '../copy-clipboard.js';
import { copyGhosts, sourceMeshes } from '../copy-ghost.js';
import type { CommandContext, CommandField, ModelingCommand, Workplane } from '../types.js';
import { buildStoreyWorkplane, elementStoreyId, isWorkplane } from '../workplane.js';

export type ArrayMode = 'linear' | 'polar';

export interface ArrayGesture {
  readonly modelId: string | null;
  /** The elements to repeat; empty when nothing (copyable) is selected. */
  readonly ids: readonly number[];
  /** What the preview shows: `ids` and the doors and windows in them. */
  readonly shown: readonly number[];
  /** Why the selection cannot be arrayed (the copy refusal), shown on a click. */
  readonly refusal: string | null;
  /** The storey the elements are on: the array's plane. */
  readonly plane: Workplane | null;
  readonly mode: ArrayMode;
  /** Linear: the clicked distance spans the whole array rather than one step. */
  readonly fit: boolean;
  /** Items including the original, at least 2. */
  readonly count: number;
  /** A typed spacing (or, with Fit, total length) in metres; null follows the cursor. */
  readonly distance: number | null;
  /** Polar: the angle the array spreads over, degrees (360 = the full turn). */
  readonly angle: number;
  /** The first click: the start of the direction, or the centre. */
  readonly anchor: Vec2 | null;
  readonly cursor: Vec2 | null;
}

const DEFAULT_COUNT = 5;

function initArrayGesture(ctx: CommandContext): ArrayGesture {
  const base: ArrayGesture = {
    modelId: null, ids: [], shown: [], refusal: null, plane: null,
    mode: 'linear', fit: false, count: DEFAULT_COUNT, distance: null, angle: 360, anchor: null, cursor: null,
  };
  const picked = selectedElements(ctx.get());
  if (!picked) return base;
  const s = ctx.get();
  const sources = copySources(s, picked.modelId, picked.ids);
  if ('refusal' in sources) return { ...base, modelId: picked.modelId, refusal: sources.refusal };
  const storeyId = elementStoreyId(s, picked.modelId, sources.ids[0]);
  const plane = storeyId === null ? null : buildStoreyWorkplane(s, picked.modelId, storeyId, 0);
  return {
    ...base,
    modelId: picked.modelId,
    ids: sources.ids,
    shown: withHostedFillings(s, picked.modelId, sources.ids),
    plane: plane && isWorkplane(plane) ? plane : null,
  };
}

/** Where the cursor is on the elements' storey, storey-local metres. */
function onPlane(g: ArrayGesture, render: readonly number[] | undefined, fallback: Vec2): Vec2 {
  if (!g.plane || !render) return fallback;
  const [x, y] = g.plane.renderToLocal([render[0], render[1], render[2]]);
  return [x, y];
}

/** The clicked (or cursor) distance, metres, for linear arrays. */
export function clickedDistance(g: ArrayGesture): number | null {
  return g.anchor && g.cursor ? Math.hypot(g.cursor[0] - g.anchor[0], g.cursor[1] - g.anchor[1]) : null;
}

/** One transform per copy (count − 1 of them), or null while the array is not defined yet. */
export function arrayTransforms(g: ArrayGesture): CopyTransform[] | null {
  if (g.count < 2) return null;
  return arrayCopyTransforms({ ...g, angleDegrees: g.angle });
}

const FIELDS: readonly CommandField<ArrayGesture>[] = [
  {
    id: 'count', labelKey: 'copyArray.field.count', unit: 'count', group: 'count',
    read: (g) => g.count, write: (g, v) => (v >= 2 ? { ...g, count: Math.round(v) } : g),
  },
  {
    id: 'spacing', labelKey: 'copyArray.field.spacing', unit: 'm', group: 'distance',
    hidden: (g) => g.mode !== 'linear' || g.fit,
    read: (g) => g.distance ?? clickedDistance(g), write: (g, v) => (v > 0 ? { ...g, distance: v } : g),
  },
  {
    id: 'total', labelKey: 'copyArray.field.total', unit: 'm', group: 'distance',
    hidden: (g) => g.mode !== 'linear' || !g.fit,
    read: (g) => g.distance ?? clickedDistance(g), write: (g, v) => (v > 0 ? { ...g, distance: v } : g),
  },
  {
    id: 'angle', labelKey: 'copyArray.field.angle', unit: 'deg', group: 'distance',
    hidden: (g) => g.mode !== 'polar',
    read: (g) => g.angle, write: (g, v) => (v !== 0 && Math.abs(v) <= 360 ? { ...g, angle: v } : g),
  },
];

function hint(g: ArrayGesture): TranslationKey {
  if (g.refusal) return 'copyArray.array.refused';
  if (g.ids.length === 0) return 'copyArray.array.noSelection';
  if (g.mode === 'polar') return g.anchor ? 'copyArray.array.polarCommit' : 'copyArray.array.polarCentre';
  return g.anchor ? 'copyArray.array.linearEnd' : 'copyArray.array.linearStart';
}

export const ELEMENT_ARRAY: ModelingCommand<ArrayGesture> = {
  id: 'element.array',
  labelKey: 'copyArray.array.label',
  hud: { Bar: ArrayBar, hint },
  fields: FIELDS,
  snap: 'modeling',
  init: initArrayGesture,
  snapQuery: (g) => ({ anchor: g.mode === 'linear' ? g.anchor : null, chain: [], locks: {} }),
  pointerMove: (g, s) => ({ ...g, cursor: onPlane(g, s.render, s.local) }),
  pointerDown(g, s) {
    if (g.refusal) return { commit: true };
    if (g.ids.length === 0) return g;
    const point = onPlane(g, s.render, s.local);
    return g.anchor ? { commit: true } : { ...g, anchor: point, cursor: point };
  },
  doubleClick: (g) => g,
  undoPoint: (g) => ({ ...g, anchor: null }),
  validate(g) {
    if (g.refusal) return { ok: true };
    if (g.ids.length === 0) return { ok: false, reasonKey: 'copyArray.array.noSelection' };
    if (!g.plane) return { ok: false, reasonKey: 'modelingCommand.noPlane' };
    return arrayTransforms(g) ? { ok: true } : { ok: false, reasonKey: hint(g) };
  },
  commit(g) {
    // A selection that cannot be arrayed says why, in the words of the copy.
    if (g.refusal) throw new Error(g.refusal);
    const transforms = arrayTransforms(g);
    if (!g.modelId || !transforms) throw new Error('Nothing to array');
    const { copies, meshed } = copyElements(useViewerStore, g.modelId, g.ids, transforms);
    return { modelId: g.modelId, created: [...copies], deleted: [], remesh: [...meshed], select: [...copies] };
  },
  afterCommit: () => ({ exit: true }),
  cancel: (g) => (g.anchor ? 'reset' : 'exit'),
  ghost(g, ctx) {
    const transforms = arrayTransforms(g);
    if (!g.modelId || !g.plane || !transforms) return [];
    const s = ctx.get();
    return copyGhosts(s, sourceMeshes(s, g.modelId, g.shown), g.plane, g.plane, transforms);
  },
};
