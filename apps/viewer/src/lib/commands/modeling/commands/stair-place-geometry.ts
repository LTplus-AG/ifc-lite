/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `stair.place`'s gesture and the rules that turn a drawn run into a flight
 * (charter #6232, D1). Its own module so the command's bar and ghost can read
 * them without importing the command.
 *
 * The run is drawn like a wall: the first click is the foot of the first
 * riser, the cursor (or a typed length and angle) puts the end. The flight
 * climbs the storey: the rise is the height to the storey above, divided into
 * the whole number of risers nearest the riser height asked for, so the top
 * tread always lands on the upper floor. Treads follow from the drawn length
 * (`run / risers`) unless a tread depth is typed, which fixes the length.
 */

import type { Vec2 } from '@/lib/snap/types';
import { modelStoreys } from '../workspace-storeys.js';
import type { CommandContext } from '../types.js';
import { planeZ } from './placement-shared.js';
import { stairSettings } from './stair-railing-settings.js';
import { endPoint, type WallPlaceGesture } from './wall-place-geometry.js';

/** A stair's run is a wall-style segment; `treadLock` is a typed tread depth. */
export interface StairPlaceGesture extends WallPlaceGesture {
  /** Typed tread depth, metres; it fixes the run at `risers × tread`. */
  treadLock: number | null;
}

export const initStairGesture = (): StairPlaceGesture => ({ chain: [], cursor: null, length: null, angle: null, treadLock: null });

/** Shorter than this a tread is not a step (metres). */
export const MIN_TREAD = 0.1;
/** Below this the storey above is treated as no storey above (a stray duplicate level), metres. */
const MIN_RISE = 0.3;
/** Risers of a flight with no storey above to climb to. */
const FREE_RISERS = 16;

export interface StairRise {
  /** Height to climb, metres; null when there is no storey above. */
  readonly rise: number | null;
  /** The storey the flight arrives at. */
  readonly upperName: string | null;
  readonly risers: number;
  readonly riser: number;
}

type Ctx = Pick<CommandContext, 'get' | 'modelId' | 'storeyId' | 'workplane'>;

/**
 * The rise from the workplane to the storey above and the risers that climb
 * it. With no storey above there is nothing to arrive at: a flight of
 * `FREE_RISERS` risers of the riser height asked for.
 */
export function stairRise(ctx: Ctx): StairRise {
  const target = stairSettings().RiserTarget;
  const storeys = modelStoreys(ctx.get(), ctx.modelId);
  const here = storeys.find((s) => s.expressId === ctx.storeyId);
  const above = here ? storeys.find((s) => s.elevation > here.elevation + 0.05) : undefined;
  const rise = here && above ? above.elevation - here.elevation - planeZ(ctx.workplane) : null;
  if (rise === null || !(rise >= MIN_RISE) || !above) {
    return { rise: null, upperName: null, risers: FREE_RISERS, riser: target };
  }
  const risers = Math.max(1, Math.round(rise / target));
  return { rise, upperName: above.name, risers, riser: rise / risers };
}

/** The run as the flight is built from it: the drawn segment, fitted. */
export interface StairFlight extends StairRise {
  readonly start: Vec2;
  readonly end: Vec2;
  /** Run direction in the plane, radians (0 = +x). */
  readonly direction: number;
  readonly run: number;
  readonly tread: number;
  readonly width: number;
  readonly waist: number;
}

/** The flight the gesture draws, or null with no start or a zero-length run. */
export function flightOf(g: StairPlaceGesture, ctx: Ctx): StairFlight | null {
  const start = g.chain[0];
  const end = endPoint(g);
  if (!start || !end) return null;
  const run = Math.hypot(end[0] - start[0], end[1] - start[1]);
  if (!(run > 1e-9)) return null;
  const fit = stairRise(ctx);
  const { Width, Waist } = stairSettings();
  return {
    ...fit,
    start,
    end,
    direction: Math.atan2(end[1] - start[1], end[0] - start[0]),
    run,
    tread: run / fit.risers,
    width: Width,
    waist: Waist,
  };
}

/** A point at `x` along the run and `y` to its left, from the start (plan, metres). */
export function alongRun(f: Pick<StairFlight, 'start' | 'direction'>, x: number, y: number): Vec2 {
  const c = Math.cos(f.direction), s = Math.sin(f.direction);
  return [f.start[0] + x * c - y * s, f.start[1] + x * s + y * c];
}

/** True when the waist leaves material under the top tread (the builder's own check). */
export function waistFits(f: Pick<StairFlight, 'risers' | 'riser' | 'tread' | 'waist'>): boolean {
  const drop = (f.waist * Math.hypot(f.riser, f.tread)) / f.tread;
  return drop < f.risers * f.riser;
}
