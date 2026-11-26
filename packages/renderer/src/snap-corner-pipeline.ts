/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The idle-time build behind screen-corner snapping (#11504). A pointer move
 * only READS the grid (`ScreenCornerIndex.query`) and tells this pipeline what
 * the view wants; every candidate build and every grid fill runs in idle
 * slices:
 *
 * - nothing runs while the view moves, and none until it has been still for
 *   `settleMs`;
 * - one pass per view walks the eligible, visible pieces in priority order
 *   (on-screen first, nearest first), building a piece's candidates if it has
 *   none and projecting them into a fresh grid. The grid answers queries while
 *   it fills, so the on-screen part of a large model is snappable first;
 * - a slice stops at its budget, inside a piece if need be: candidate and grid
 *   building run in chunks with a cursor, so one huge piece spans several slices.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { PickClipState } from './pick-types.js';
import { isEntityVisible } from './entity-visibility.js';
import type { MeshGeometryCache } from './snap-geometry-cache.js';
import { finishedBuild, type StepBuild } from './snap-geometry-build.js';
import { CandidateBuild, type PieceCandidates } from './snap-corner-candidates.js';
import { CornerGrid, type ScreenSnapCamera } from './snap-corner-grid.js';
import { gridKey, idsOf } from './snap-corner-key.js';
import { PriorityOrder } from './snap-corner-priority.js';
import { browserIdleHost, type IdleHost, type IdleSlice } from './snap-idle-host.js';

export const DEFAULT_SETTLE_MS = 120;
/** Longest one idle slice works, however much idle time the host offers. */
export const DEFAULT_MAX_SLICE_MS = 6;

/** What the build needs of the latest pick; replaced on every query. */
export interface BuildContext {
  pieces: readonly MeshData[];
  geometryFor: (mesh: MeshData) => MeshGeometryCache;
  /** The same cache built in bounded steps; preferred over `geometryFor`, which builds a piece in one call. */
  startGeometry?: (mesh: MeshData) => StepBuild<MeshGeometryCache>;
  camera: ScreenSnapCamera & { getPosition(): { x: number; y: number; z: number } };
  viewport: { width: number; height: number };
  /** The view's stamp NOW (the camera may have moved since the last pick). */
  liveViewKey: () => string;
  hiddenIds?: ReadonlySet<number>;
  isolatedIds?: ReadonlySet<number> | null;
  eligible?: ReadonlySet<number>;
  clip?: PickClipState | null;
  cell: number;
  settleMs: number;
  maxSliceMs: number;
  now: () => number;
}

export interface BuildStats {
  /** Eligible, visible pieces of the latest pick. */
  activePieces: number;
  /** Of those, how many have candidates. */
  candidatePieces: number;
  /** Pieces in the grid being served. */
  gridPieces: number;
  /** True when the grid covers every active piece. */
  complete: boolean;
  /** Grids started so far, and candidate builds run so far. */
  gridsStarted: number;
  candidateBuilds: number;
  slices: number;
  /** Heap held by candidates and the grid, bytes (typed arrays and number arrays, excluding cell lists). */
  approxBytes: number;
}

interface Run {
  key: string;
  pieces: readonly MeshData[];
  grid: CornerGrid;
  /** Ordering phase (bounds, screen tests), then the ordered work list. */
  ordering: PriorityOrder | null;
  order: MeshData[] | null;
  cursor: number;
  active: MeshData[];
}

export class CornerBuildPipeline {
  private candidates = new WeakMap<MeshData, PieceCandidates>();
  /** Candidate builds a slice stopped inside; the next slice resumes them. */
  private building = new WeakMap<MeshData, CandidateBuild>();
  /** Geometry builds a slice stopped inside, one per piece without candidates. */
  private geometry = new WeakMap<MeshData, StepBuild<MeshGeometryCache>>();
  private candidatePieces = 0;
  private candidateBuilds = 0;
  private gridsStarted = 0;
  private slices = 0;
  private candidateBytes = 0;
  private ctx: BuildContext | null = null;
  private seen: { key: string; at: number } | null = null;
  private run: Run | null = null;
  private handle: unknown = null;
  private activeCache: { pieces: readonly MeshData[]; filterKey: string; list: MeshData[] } | null = null;

  constructor(private readonly host: IdleHost = browserIdleHost()) {}

  /** The grid built for exactly this view, or null (the view moved, or nothing is built yet). */
  gridFor(key: string): CornerGrid | null {
    const g = this.run?.grid;
    return g && g.key === key && g.pieces.length > 0 ? g : null;
  }

  /** Called on every pick: remember what the view wants and make sure an idle slice is scheduled if work remains. */
  observe(ctx: BuildContext, key: string): void {
    this.ctx = ctx;
    const t = ctx.now();
    if (this.seen?.key !== key) this.seen = { key, at: t };
    if (!this.isComplete(ctx, key)) this.schedule();
  }

  stats(): BuildStats {
    const run = this.run;
    const active = this.ctx ? this.activeOf(this.ctx).length : 0;
    return {
      activePieces: active, candidatePieces: this.candidatePieces, gridPieces: run?.grid.pieces.length ?? 0,
      complete: !!this.ctx && this.isComplete(this.ctx, this.keyOf(this.ctx)),
      gridsStarted: this.gridsStarted, candidateBuilds: this.candidateBuilds, slices: this.slices,
      approxBytes: this.candidateBytes + (run?.grid.approxBytes() ?? 0),
    };
  }

  /** Drop everything built from geometry and stop the idle work. */
  clear(): void {
    if (this.handle !== null) this.host.cancel(this.handle);
    this.handle = null;
    this.candidates = new WeakMap();
    this.building = new WeakMap();
    this.geometry = new WeakMap();
    this.candidatePieces = 0;
    this.candidateBytes = 0;
    this.ctx = null; this.seen = null; this.run = null; this.activeCache = null;
  }

  private activeOf(ctx: BuildContext): MeshData[] {
    const filterKey = `${idsOf(ctx.hiddenIds)}|${idsOf(ctx.isolatedIds)}|${idsOf(ctx.eligible)}`;
    const c = this.activeCache;
    if (c && c.pieces === ctx.pieces && c.filterKey === filterKey) return c.list;
    const list = ctx.pieces.filter((p) =>
      (ctx.eligible === undefined || ctx.eligible.has(p.modelIndex ?? 0)) && isEntityVisible(p.expressId, ctx.hiddenIds, ctx.isolatedIds));
    this.activeCache = { pieces: ctx.pieces, filterKey, list };
    return list;
  }

  /** The view as the grid sees it right now. */
  private keyOf(ctx: BuildContext): string {
    return gridKey(ctx.liveViewKey(), ctx.clip, ctx.viewport.width, ctx.viewport.height,
      ctx.hiddenIds, ctx.isolatedIds, ctx.cell, ctx.eligible);
  }

  private isComplete(ctx: BuildContext, key: string): boolean {
    const r = this.run;
    return !!r && r.key === key && r.pieces === ctx.pieces && r.order !== null && r.cursor >= r.order.length;
  }

  private schedule(afterMs = 0): void {
    if (this.handle !== null) return;
    this.handle = this.host.request((slice) => { this.handle = null; this.slice(slice); }, afterMs);
  }

  private slice(idle: IdleSlice): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.slices++;
    const key = this.keyOf(ctx);
    const t0 = ctx.now();
    if (this.seen?.key !== key) this.seen = { key, at: t0 };
    const wait = ctx.settleMs - (t0 - this.seen.at);
    if (wait > 0) { this.schedule(wait); return; } // the view is moving (or just moved): nothing runs
    if (this.isComplete(ctx, key)) return;

    // An idle slice forced by its timeout reports no time: still make progress, within a small budget.
    const budget = Math.min(ctx.maxSliceMs, idle.didTimeout ? 4 : idle.timeRemaining());
    const end = t0 + budget;
    const over = () => ctx.now() >= end;

    let run = this.run;
    if (!run || run.key !== key || run.pieces !== ctx.pieces) {
      // Same view, more pieces (geometry still arriving): keep filling the grid we have.
      const grid = run && run.key === key ? run.grid : this.startGrid(ctx, key);
      const active = this.activeOf(ctx);
      run = this.run = { key, pieces: ctx.pieces, grid, ordering: null, order: null, cursor: 0, active };
    }
    if (run.order === null) {
      run.ordering ??= new PriorityOrder(run.active.filter((q) => !run!.grid.has(q)), ctx.camera, ctx.viewport);
      run.ordering.step(over);
      if (!run.ordering.done) { this.schedule(); return; }
      run.order = run.ordering.result();
      run.ordering = null;
      run.cursor = 0;
    }
    const order = run.order;
    // A piece is built in chunks: the clock is read between chunks, so one huge piece spans several slices.
    while (run.cursor < order.length) {
      const piece = order[run.cursor];
      let cand = this.candidates.get(piece);
      if (!cand) {
        let build = this.building.get(piece);
        if (!build) {
          // The snap geometry (weld, classify, merge) is built in steps too: its stages are the
          // longest atomic work a slice can meet on a large piece.
          let geo = this.geometry.get(piece);
          if (!geo) {
            geo = ctx.startGeometry ? ctx.startGeometry(piece) : finishedBuild(ctx.geometryFor(piece));
            this.geometry.set(piece, geo);
            if (over()) break;
          }
          while (!geo.done && !geo.step()) if (over()) break;
          if (!geo.done) break;
          build = new CandidateBuild(piece.expressId, geo.result());
          this.geometry.delete(piece);
          this.building.set(piece, build);
          if (over()) break;
        }
        while (!build.step()) if (over()) break;
        if (over() && !build.done) break;
        cand = build.result();
        this.building.delete(piece);
        this.candidates.set(piece, cand);
        this.candidatePieces++; this.candidateBuilds++;
        this.candidateBytes += 8 * (cand.corners.length + cand.edges.length);
      }
      while (!run.grid.addPieceStep(piece, cand)) if (over()) break;
      if (!run.grid.has(piece)) break;
      run.cursor++;
      if (over()) break;
    }
    if (run.cursor < order.length) this.schedule();
  }

  private startGrid(ctx: BuildContext, key: string): CornerGrid {
    this.gridsStarted++;
    return new CornerGrid(key, ctx.camera, ctx.viewport, ctx.cell, ctx.clip);
  }
}
