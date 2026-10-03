/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ViewerState } from '@/store';
import { SpaceEnvelopeBar, SpaceEnvelopeScene } from '@/components/viewer/tools/command/SpaceEnvelopeHud';
import { buildStoreyWorkplane, isWorkplane } from '../workplane';
import { selectedSpace, spaceEnvelopeWorkplane } from '@/lib/rooms/space-envelope-workplane';
import { ceilingAt, envelopeMeasures, sectionEnvelope } from '@/lib/rooms/space-envelope';
import { writeSpaceEnvelope } from '@/lib/rooms/space-envelope-write';
import type { SpaceEnvelopeTarget } from '@/lib/rooms/space-envelope-read';
import type { Vec2 } from '@/lib/snap/types';
import type { CommandContext, CommandField, ModelingCommand } from '../types';

export type EnvelopeMode = 'flat' | 'slope' | 'pitched';
export interface SpaceEnvelopeGesture {
  target: SpaceEnvelopeTarget | null;
  version: number;
  models: ViewerState['models'];
  placement: ViewerState['modelPlacement'];
  section: ViewerState['sectionPlane'];
  mode: EnvelopeMode;
  direction: Vec2;
  points: readonly Vec2[];
  floor: number;
  /** -1 = floor, 0..2 = ceiling points. */
  active: number | null;
  changed: boolean;
}

export function setEnvelopeMode(g: SpaceEnvelopeGesture, mode: EnvelopeMode): SpaceEnvelopeGesture {
  if (g.points.length < 2) return g;
  const left = g.points[0], right = g.points[g.points.length - 1];
  const middle: Vec2 = [(left[0] + right[0]) / 2, Math.max(left[1], right[1]) + 0.5];
  return { ...g, mode, active: null, changed: true, points: mode === 'pitched' ? [left, middle, right]
    : mode === 'flat' ? [left, [right[0], left[1]]] : [left, right] };
}

export function envelopeHandlePoints(g: SpaceEnvelopeGesture): readonly Vec2[] {
  return g.points.length < 2 ? [] : [[(g.points[0][0] + g.points[g.points.length - 1][0]) / 2, g.floor], ...g.points];
}

function init(ctx: CommandContext): SpaceEnvelopeGesture {
  const s = ctx.get(), target = ctx.workplane ? selectedSpace(ctx) : null;
  const empty: SpaceEnvelopeGesture = { target: null, version: s.mutationVersion, models: s.models, placement: s.modelPlacement, section: s.sectionPlane, mode: 'flat', direction: [1, 0], points: [], floor: 0, active: null, changed: false };
  if (!target || !ctx.workplane) return empty;
  const base = buildStoreyWorkplane(s, target.modelId, target.storeyId, 0);
  if (!isWorkplane(base)) return empty;
  const origin = base.renderToLocal(ctx.workplane.localToRender([0, 0, 0]));
  const next = base.renderToLocal(ctx.workplane.localToRender([1, 0, 0]));
  const direction: Vec2 = [next[0] - origin[0], next[1] - origin[1]];
  const planes = target.envelope.ceiling;
  // Both roof faces must run along this elevation's horizontal axis. Otherwise
  // displaying a single slice and writing it across the room would flatten a slope.
  if (planes.some(p => Math.abs(-p.a * direction[1] + p.b * direction[0]) > 1e-6)) return empty;
  const us = target.chain.footprint.map(p => p[0] * direction[0] + p[1] * direction[1]);
  const lo = Math.min(...us), hi = Math.max(...us);
  const at = (u: number): Vec2 => [u, ceilingAt(planes, [direction[0] * u, direction[1] * u])];
  let points = [at(lo), at(hi)];
  if (planes.length === 2) {
    const [a, b] = planes;
    const denominator = (a.a - b.a) * direction[0] + (a.b - b.b) * direction[1];
    const ridge = (b.c - a.c) / denominator;
    if (Number.isFinite(ridge) && ridge > lo + 0.01 && ridge < hi - 0.01) points = [at(lo), at(ridge), at(hi)];
  }
  const mode = points.length === 3 ? 'pitched' : Math.abs(points[0][1] - points[1][1]) > 1e-6 ? 'slope' : 'flat';
  return { ...empty, target, direction, points, floor: target.envelope.floor, mode };
}

export function moveEnvelopeHandle(g: SpaceEnvelopeGesture, p: Vec2): SpaceEnvelopeGesture {
  if (g.active === null) return g;
  if (g.active === -1) return { ...g, floor: p[1], changed: true };
  const points = g.points.map((v, i): Vec2 => {
    if (g.mode === 'flat') return [v[0], p[1]];
    if (i !== g.active) return v;
    // Eaves stay at the footprint edges; the ridge may move horizontally.
    const u = g.mode === 'pitched' && i === 1 ? Math.max(g.points[0][0] + 0.01, Math.min(g.points[2][0] - 0.01, p[0])) : v[0];
    return [u, p[1]];
  });
  return { ...g, points, changed: true };
}

const field = (id: string, labelKey: CommandField<SpaceEnvelopeGesture>['labelKey'], index: number): CommandField<SpaceEnvelopeGesture> => ({
  id, labelKey, unit: 'm', hidden: g => !g.target || index === 1 && g.mode !== 'pitched',
  read: g => index === -1 ? g.floor : g.points[index === 2 ? g.points.length - 1 : index]?.[1] ?? null,
  write: (g, v) => ({ ...moveEnvelopeHandle({ ...g, active: index === 2 ? g.points.length - 1 : index }, [g.points[index]?.[0] ?? 0, v]), active: null }),
});

export const SPACE_ENVELOPE: ModelingCommand<SpaceEnvelopeGesture> = {
  id: 'space.envelope', labelKey: 'spaceEnvelope.label', workplane: spaceEnvelopeWorkplane,
  hud: { Bar: SpaceEnvelopeBar, Scene: SpaceEnvelopeScene, hint: g => !g.target ? 'spaceEnvelope.refused' : g.active === null ? 'spaceEnvelope.pick' : 'spaceEnvelope.move' },
  fields: [field('floor', 'spaceEnvelope.floor', -1), field('left', 'spaceEnvelope.left', 0), field('ridge', 'spaceEnvelope.ridge', 1), field('right', 'spaceEnvelope.right', 2)],
  // Plan axes and floor grids aren't valid sources in an elevation; use the
  // shared solver's mesh candidates and constraints on this vertical plane.
  snap: { radiusPx: 12, tiers: [['endpoint', 'vertex'], ['midpoint', 'intersection'], ['edge'], ['face']], sources: ['mesh'], hysteresisPx: 3 },
  init,
  pickExclusions: g => g.target ? [{ modelId: g.target.modelId, expressId: g.target.expressId }] : [],
  snapQuery: g => ({ anchor: g.active === null ? null : envelopeHandlePoints(g)[g.active + 1], chain: [], locks: g.active === 1 && g.mode === 'pitched' ? {} : { axis: 'v' } }),
  pointerMove: (g, s) => moveEnvelopeHandle(g, s.local),
  pointerDown(g, s) {
    if (g.active !== null) return g.changed ? { commit: true } : g;
    const points = envelopeHandlePoints(g);
    const distance = points.map(p => Math.hypot(p[0] - s.local[0], p[1] - s.local[1]));
    const i = distance.indexOf(Math.min(...distance));
    return i >= 0 && distance[i] <= 14 * (s.metresPerPixel ?? 0.02) ? { ...g, active: i - 1 } : g;
  },
  validate(g) {
    const envelope = sectionEnvelope(g);
    return g.target && g.changed && envelope && envelopeMeasures(g.target.chain.footprint, envelope)
      ? { ok: true } : { ok: false, reasonKey: g.target ? 'spaceEnvelope.invalid' : 'spaceEnvelope.refused' };
  },
  commit(g, tx) {
    const envelope = sectionEnvelope(g);
    if (!g.target || !envelope || tx.store.mutationVersion !== g.version
      || tx.store.models !== g.models || tx.store.modelPlacement !== g.placement || tx.store.sectionPlane !== g.section) throw new Error('The space changed during the gesture. Start the envelope edit again.');
    const { modelId, expressId } = g.target;
    writeSpaceEnvelope(tx, modelId, expressId, envelope);
    return { modelId, created: [], deleted: [], remesh: [expressId], select: [expressId] };
  },
  afterCommit: () => ({ exit: true }), cancel: () => 'exit',
};
