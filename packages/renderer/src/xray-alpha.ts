/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * X-Ray alpha resolution: per ENTITY, and the batch partition that makes a
 * per-entity alpha reachable on the batched draw path.
 *
 * `RenderOptions.transparencyOverrides` is a `Map<expressId, alpha>` and
 * `ghostExceptIds` is a `Set<expressId>` — both name entities. Flat geometry,
 * though, is drawn as merged colour batches with ONE uniform alpha per draw,
 * and the vertices carry no entity lane the shader could branch on. Fading one
 * entity therefore used to fade every batchmate that happened to share its
 * colour (#4129): the caller's X-Ray set held one id and the screen showed a
 * group, so everything keyed on that set (picking, counts, exports) disagreed
 * with what the user saw.
 *
 * The fix reuses the machinery that already draws a SUBSET of a batch — the
 * cached partial sub-batches built for hide/isolate and for colour-override
 * promotion. A batch whose entities resolve to more than one alpha is
 * partitioned into one sub-batch per distinct alpha, each drawn with its own
 * uniform. No vertex format, shader, or pipeline change.
 *
 * The partition is only ever an OPTIMIZATION target, never a correctness
 * requirement: when a batch cannot be partitioned (its CPU geometry was
 * released or evicted, or it is colour-merged — see `Scene.canPartitionBatch`)
 * the caller falls back to drawing it whole at {@link XRayAlpha.forBatch}, the
 * minimum alpha across its non-selected ids. That is the pre-#4129 behaviour,
 * so degrading is a fade that is too wide, never geometry that goes missing.
 */

import type { RenderOptions } from './types.js';
import { DEFAULT_GHOST_ALPHA } from './overlay-routing.js';

/** The part of a batch (or sub-batch) alpha resolution reads. */
export interface AlphaBatchLike {
  expressIds: readonly number[];
  color: readonly [number, number, number, number];
}

/** One sub-batch's worth of entities: every id here resolves to `alpha`. */
export interface AlphaGroup {
  alpha: number;
  ids: Set<number>;
}

/**
 * Cap on the number of distinct alphas one batch is split into. Each group
 * costs a cached GPU sub-batch (its own vertex + index buffers), so a caller
 * that hands out many distinct alphas across one colour batch would multiply
 * that batch's VRAM. Past the cap the batch falls back to the whole-batch
 * minimum alpha — wider than asked for, but bounded.
 *
 * Two is the shape every real X-Ray state produces (the faded ids, and the
 * rest), so the cap is generous headroom rather than a routine limit.
 */
export const MAX_ALPHA_GROUPS_PER_BATCH = 8;

/** Alphas within 1/1000 of each other share a group (the batch colour key uses
 *  the same quantization, so this is the finest distinction a batch can carry). */
const ALPHA_KEY_SCALE = 1000;

/**
 * Per-frame X-Ray state: a snapshot of the caller's `transparencyOverrides` /
 * `ghostExceptIds` plus the resolution rules that read them.
 *
 * Snapshotting matters: the renderer classifies a batch (opaque vs transparent
 * pipeline) and writes its uniform at two different points in the frame, and a
 * caller mutating its map in between would desync the two.
 */
export class XRayAlpha {
  /** False when no override and no ghost set is active — every resolver is then
   *  an identity on the fallback and the caller can skip the machinery. */
  readonly active: boolean;
  private readonly overrides: Map<number, number> | null;
  private readonly ghostExcept: ReadonlySet<number> | null;
  private readonly ghostAlpha: number;
  private readonly selected: ReadonlySet<number>;
  // Resolved-per-batch results for THIS frame. Classification and the uniform
  // write both need them, and recomputing would walk every id twice per batch.
  private readonly batchCache = new WeakMap<object, { alpha: number; groups: AlphaGroup[] | null }>();

  constructor(options: RenderOptions, selectedExpressIds: ReadonlySet<number>) {
    const src = options.transparencyOverrides;
    this.overrides = src != null && src.size > 0 ? new Map(src) : null;
    this.ghostExcept = options.ghostExceptIds ?? null;
    this.ghostAlpha = options.ghostAlpha ?? DEFAULT_GHOST_ALPHA;
    this.selected = selectedExpressIds;
    this.active = this.overrides != null || this.ghostExcept != null;
  }

  /**
   * Resolved alpha for one entity. Selected entities are exempt at every site:
   * the highlight pass repaints them last, and exempting here keeps
   * classification and the uniform write from disagreeing about them.
   */
  forEntity(expressId: number, fallback: number): number {
    if (!this.active) return fallback;
    if (this.selected.has(expressId)) return fallback;
    const a = this.overrides?.get(expressId);
    if (a !== undefined) return a;
    if (this.ghostExcept != null && !this.ghostExcept.has(expressId)) return this.ghostAlpha;
    return fallback;
  }

  /**
   * Alpha for a batch drawn WHOLE: the minimum override alpha across its
   * non-selected ids, or `fallback` when no id in it carries one. Correct on
   * its own for a homogeneous (sub-)batch, and the documented fallback for a
   * mixed batch that cannot be partitioned.
   */
  forBatch(batch: AlphaBatchLike, fallback: number): number {
    if (!this.active) return fallback;
    return this.resolve(batch, fallback).alpha;
  }

  /**
   * The per-alpha partition of a batch, or `null` when it needs none — every
   * id resolves to the same alpha, or the distinct count exceeded
   * {@link MAX_ALPHA_GROUPS_PER_BATCH}. Groups come back in a deterministic
   * order (ascending alpha) so a group keeps the same sub-batch cache slot
   * across frames while its content is unchanged.
   */
  groupsForBatch(batch: AlphaBatchLike, fallback: number): AlphaGroup[] | null {
    if (!this.active) return null;
    return this.resolve(batch, fallback).groups;
  }

  /**
   * Same partition over an arbitrary id subset — the visible subset of a
   * partially hidden batch, which is not the batch's own id list.
   */
  groupsForIds(ids: Iterable<number>, fallback: number): AlphaGroup[] | null {
    if (!this.active) return null;
    return partitionByAlpha(ids, (id) => this.forEntity(id, fallback));
  }

  private resolve(batch: AlphaBatchLike, fallback: number): { alpha: number; groups: AlphaGroup[] | null } {
    const cached = this.batchCache.get(batch);
    if (cached !== undefined) return cached;
    // ONE walk for both answers, and no allocation at all for the common case
    // (a batch that resolves to a single alpha — e.g. every fully-ghosted batch
    // on the model, every frame X-Ray is on). The group Sets are built by a
    // second walk below, paid only by the batches that are genuinely mixed.
    //
    // The minimum is taken over ids that actually carry an override: an id with
    // no entry contributes nothing, so a batch of untouched entities keeps its
    // native (possibly translucent) colour alpha rather than being clamped.
    // That is `forEntity`'s rule with the "was it overridden" bit kept, which is
    // why the resolution is spelled out again here instead of calling it.
    let min = Infinity;
    let firstKey = 0;
    let haveFirstKey = false;
    let extraKeys: number[] | null = null;
    for (const eid of batch.expressIds) {
      let alpha = fallback;
      if (!this.selected.has(eid)) {
        const o = this.overrides?.get(eid);
        if (o !== undefined) {
          alpha = o;
          if (o < min) min = o;
        } else if (this.ghostExcept != null && !this.ghostExcept.has(eid)) {
          alpha = this.ghostAlpha;
          if (this.ghostAlpha < min) min = this.ghostAlpha;
        }
      }
      const key = Math.round(alpha * ALPHA_KEY_SCALE);
      if (!haveFirstKey) {
        firstKey = key;
        haveFirstKey = true;
      } else if (key !== firstKey) {
        // Stop collecting past the cap: we already know the batch is over it,
        // and an unbounded array here would make the linear scan quadratic.
        if (extraKeys === null) extraKeys = [key];
        else if (extraKeys.length < MAX_ALPHA_GROUPS_PER_BATCH && !extraKeys.includes(key)) extraKeys.push(key);
      }
    }
    const mixed = extraKeys !== null && extraKeys.length < MAX_ALPHA_GROUPS_PER_BATCH;
    const resolved = {
      alpha: min === Infinity ? fallback : min,
      groups: mixed ? partitionByAlpha(batch.expressIds, (id) => this.forEntity(id, fallback)) : null,
    };
    this.batchCache.set(batch, resolved);
    return resolved;
  }
}

/**
 * Group ids by resolved alpha. Returns `null` when there is nothing to gain —
 * fewer than two distinct alphas — or when the distinct count would exceed
 * {@link MAX_ALPHA_GROUPS_PER_BATCH}.
 */
function partitionByAlpha(
  ids: Iterable<number>,
  alphaOf: (expressId: number) => number,
): AlphaGroup[] | null {
  const byKey = new Map<number, AlphaGroup>();
  for (const id of ids) {
    const alpha = alphaOf(id);
    const key = Math.round(alpha * ALPHA_KEY_SCALE);
    const group = byKey.get(key);
    if (group) {
      group.ids.add(id);
      // Quantization can put two alphas a hair apart in one group; draw the
      // more transparent of them so an X-Ray request is never under-applied.
      if (alpha < group.alpha) group.alpha = alpha;
    } else {
      if (byKey.size >= MAX_ALPHA_GROUPS_PER_BATCH) return null;
      byKey.set(key, { alpha, ids: new Set([id]) });
    }
  }
  if (byKey.size < 2) return null;
  return [...byKey.values()].sort((a, b) => a.alpha - b.alpha);
}

/**
 * Content-based change tracking for the X-Ray sets, mirroring
 * `VisibilityEpochTracker`: the partial sub-batch cache keys on an epoch, so
 * the epoch has to bump EXACTLY when the effective X-Ray state changes.
 * Callers pass a fresh `Map`/`Set` every frame (zustand rebuilds them) or
 * mutate one in place, so only a content comparison gets both right.
 */
export class XRayEpochTracker {
  private version = 0;
  private overrides: Map<number, number> | null = null;
  private ghostExcept: Set<number> | null = null;
  private ghostAlpha = DEFAULT_GHOST_ALPHA;

  update(options: RenderOptions): number {
    const src = options.transparencyOverrides;
    const live = src != null && src.size > 0 ? src : null;
    const ghost = options.ghostExceptIds ?? null;
    const alpha = options.ghostAlpha ?? DEFAULT_GHOST_ALPHA;
    const changed =
      !alphaMapEquals(live, this.overrides) ||
      !setContentEquals(ghost, this.ghostExcept) ||
      alpha !== this.ghostAlpha;
    if (changed) {
      this.version++;
      this.overrides = live ? new Map(live) : null;
      this.ghostExcept = ghost ? new Set(ghost) : null;
      this.ghostAlpha = alpha;
    }
    return this.version;
  }

  getVersion(): number {
    return this.version;
  }
}

function alphaMapEquals(
  live: ReadonlyMap<number, number> | null,
  snapshot: ReadonlyMap<number, number> | null,
): boolean {
  if (live === snapshot) return true; // covers null === null
  if (live === null || snapshot === null) return false;
  if (live.size !== snapshot.size) return false;
  for (const [id, alpha] of live) {
    if (snapshot.get(id) !== alpha) return false;
  }
  return true;
}

function setContentEquals(
  live: ReadonlySet<number> | null,
  snapshot: ReadonlySet<number> | null,
): boolean {
  if (live === snapshot) return true;
  if (live === null || snapshot === null) return false;
  if (live.size !== snapshot.size) return false;
  for (const id of live) {
    if (!snapshot.has(id)) return false;
  }
  return true;
}
