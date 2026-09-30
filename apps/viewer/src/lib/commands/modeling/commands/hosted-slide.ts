/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `hosted.slide` (charter #6232, B3): drag the selected opening, door or
 * window along its host wall. The cursor goes through the shared snap solver
 * and is projected onto the wall; the element's centre follows it, clamped so
 * the cut stays inside the wall. While the pointer is down only a ghost moves;
 * release writes the new Offset through the same store write the inspector's
 * Hosting section uses (`moveHostedFillIn`), in one transaction: one undo
 * step, and the host re-meshed with its moved void.
 *
 * Started from the plan's slide handle (`beginHostedSlide`), like
 * `wall.moveEndpoint` from an end handle.
 */

import { placedBodyExtent, readHostedFill } from '@ifc-lite/create';
import { useViewerStore } from '@/store';
import type { ViewerState } from '@/store';
import { resolveEntityRef } from '@/store/resolveEntityRef';
import { moveHostedFillIn } from '@/store/slices/mutation-hosted-fill';
import { getModelLengthUnitScale } from '@/lib/length-unit-scale';
import type { Vec2 } from '@/lib/snap/types';
import { commandGhostId } from '../ghost.js';
import { prismGhostMesh } from '../ghost-shapes.js';
import { commitCommand, getCommandRuntime } from '../runtime.js';
import type { CommandContext, ModelingCommand } from '../types.js';
import { planeZ } from './placement-shared.js';
import { fromHostLocal, readHost, toHostLocal, type HostHit } from './hosted-host.js';

/** Where a hosted element sits in its host and how far it may slide; metres, the host's frame. */
export interface HostedSlideTarget {
  readonly modelId: string;
  /** The selected element: the opening, or the door or window filling it. */
  readonly expressId: number;
  readonly host: HostHit;
  /** The opening's Offset now (its placement origin along the host). */
  readonly offset: number;
  /** The cut's extent along the host and up it, relative to `offset` along. */
  readonly along: readonly [number, number];
  readonly up: readonly [number, number];
  /** The Offsets that keep the cut inside the host (`moveHostedFillIn`'s fit rule). */
  readonly range: readonly [number, number];
}

export interface HostedSlideGesture {
  readonly target: HostedSlideTarget | null;
  /** The Offset the drag has reached; null until the first move. */
  readonly offset: number | null;
}

/**
 * The selected element as a slide target, or null when it is not an opening
 * (or a door or window in one) placed relative to a wall whose body and its
 * own cut can be read.
 */
export function readHostedSlide(s: ViewerState, modelId: string, expressId: number): HostedSlideTarget | null {
  const dataStore = s.models.get(modelId)?.ifcDataStore;
  const view = s.mutationViews.get(modelId) ?? null;
  if (!dataStore) return null;
  const fill = readHostedFill(dataStore, expressId, view);
  const host = fill ? readHost(s, modelId, fill.hostId) : null;
  const cut = fill ? placedBodyExtent(dataStore, fill.openingId, view) : null;
  if (!fill || !host || !cut) return null;
  const k = getModelLengthUnitScale(dataStore);
  const along = [cut.min[0] * k - fill.offset, cut.max[0] * k - fill.offset] as const;
  const up = [cut.min[2] * k, cut.max[2] * k] as const;
  const lo = host.x[0] - along[0], hi = host.x[1] - along[1];
  // A cut wider than its wall has nowhere to go: it stays where it is.
  const range = lo <= hi ? [lo, hi] as const : [fill.offset, fill.offset] as const;
  return { modelId, expressId, host, offset: fill.offset, along, up, range };
}

/** The Offset that puts the cut's centre at `cursor` (storey-local), clamped into the host. */
export function slideOffset(target: HostedSlideTarget, cursor: Vec2): number {
  const centre = (target.along[0] + target.along[1]) / 2;
  const wanted = toHostLocal(target.host, cursor)[0] - centre;
  return Math.min(target.range[1], Math.max(target.range[0], wanted));
}

/** The cut's centre on the wall's axis line, storey-local: where the plan draws the slide handle. */
export function slideHandlePoint(target: HostedSlideTarget, offset = target.offset): Vec2 {
  const { host, along } = target;
  return fromHostLocal(host, [offset + (along[0] + along[1]) / 2, (host.y[0] + host.y[1]) / 2]);
}

/** Below this a slide is no slide (metres). */
const MIN_SLIDE = 1e-6;

function init(ctx: CommandContext): HostedSlideGesture {
  const s = ctx.get();
  if (s.selectedEntityId === null) return { target: null, offset: null };
  const { modelId, expressId } = resolveEntityRef(s.selectedEntityId);
  return { target: readHostedSlide(s, modelId, expressId), offset: null };
}

export const HOSTED_SLIDE: ModelingCommand<HostedSlideGesture> = {
  id: 'hosted.slide',
  labelKey: 'planHandles.slide.label',
  hud: { hint: () => 'planHandles.slide.hint' },
  snap: 'modeling',
  init,
  snapQuery: () => ({ anchor: null, chain: [], locks: {} }),
  pointerMove: (g, s) => (g.target ? { ...g, offset: slideOffset(g.target, s.local) } : g),
  pointerDown: (g) => g,
  validate: (g) => (g.target && g.offset !== null ? { ok: true } : { ok: false, reasonKey: 'planHandles.slide.notHosted' }),
  commit(g) {
    if (!g.target || g.offset === null) throw new Error('Nothing to slide');
    const { modelId, expressId } = g.target;
    const moved = moveHostedFillIn(useViewerStore, modelId, expressId, { offset: g.offset });
    if (!moved.ok) throw new Error(moved.reason);
    return { modelId, created: [], deleted: [], remesh: [...moved.remesh], select: [expressId] };
  },
  afterCommit: () => ({ exit: true }),
  cancel: () => 'exit',
  ghost(g, ctx) {
    const { target, offset } = g;
    if (!target || offset === null || !ctx.workplane) return [];
    const { host, along, up } = target;
    // Through the wall's body and a hair beyond, as the placing commands draw it.
    const y0 = host.y[0] - 0.01, y1 = host.y[1] + 0.01;
    const a = offset + along[0], b = offset + along[1];
    const outline = ([[a, y0], [b, y0], [b, y1], [a, y1]] as Vec2[]).map((p) => fromHostLocal(host, p));
    const base = host.origin[2] - planeZ(ctx.workplane);
    const mesh = prismGhostMesh(ctx.workplane, outline, base + up[0], base + up[1], commandGhostId(ctx.get()));
    return mesh ? [mesh] : [];
  },
};

/** The slide handle was grabbed: run the command until the pointer is released. */
export function beginHostedSlide(): void {
  useViewerStore.getState().startCommand(HOSTED_SLIDE.id);
  if (getCommandRuntime().command?.id !== HOSTED_SLIDE.id) return;
  window.addEventListener('pointerup', () => {
    const runtime = getCommandRuntime();
    if (runtime.command?.id !== HOSTED_SLIDE.id) return; // cancelled with Escape
    const g = runtime.gesture as HostedSlideGesture;
    // A press without a drag, or a drag back to where it was, writes nothing.
    if (g.target && g.offset !== null && Math.abs(g.offset - g.target.offset) > MIN_SLIDE) commitCommand();
    if (getCommandRuntime().command?.id === HOSTED_SLIDE.id) useViewerStore.getState().endCommand('cancel');
  }, { once: true });
}
