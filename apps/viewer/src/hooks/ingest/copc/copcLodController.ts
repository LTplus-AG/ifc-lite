/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Keeps the renderer's resident COPC nodes matched to the view (#6869).
 *
 * Pure orchestration: no renderer, worker or clock of its own. The host
 * hands in a reader (page/node I/O), a sink (append/remove a keyed chunk)
 * and a clock, so the residency rules are unit-testable.
 *
 * Per view (`update(camera)`):
 * 1. Select the full-budget node set once; that set is the KEEP set.
 * 2. Run the pacer's passes (a time-boxed first pass, then the full
 *    budget). Each pass loads missing hierarchy pages (bounded rounds),
 *    then fetches nodes it lacks, parents first, a few at a time.
 * 3. Budget is a hard ceiling on resident points. Before a node is added,
 *    room is made by evicting the least recently wanted node outside the
 *    keep set; only then a keep-set node holding more points than its
 *    current share. A node that still does not fit is skipped.
 * 4. When a pass completes and `shouldReplacePass` says it beats what is
 *    on screen, everything outside the keep set is evicted. Nothing is
 *    removed before its replacement is resident, so moving the camera
 *    never punches holes in the picture.
 * A newer `update` aborts the older one; an aborted pass never touches the
 * sink again.
 */

import {
  LodPacer,
  selectLod,
  shouldReplacePass,
  type CopcLodNode,
  type CopcLodTree,
  type CopcNodeEntry,
  type CopcPageRef,
  type DecodedPointChunk,
  type LodCamera,
  type LodPassQuality,
} from '@ifc-lite/pointcloud';

export interface CopcLodReader {
  loadPage(ref: CopcPageRef, signal?: AbortSignal): Promise<void>;
  readNode(node: CopcNodeEntry, options: { stride: number; signal?: AbortSignal }): Promise<DecodedPointChunk>;
}

export interface CopcLodSink {
  append(node: CopcLodNode, chunk: DecodedPointChunk): void;
  remove(node: CopcLodNode): void;
}

export interface CopcLodControllerOptions {
  pointBudget: number;
  pacer?: LodPacer;
  /** Parallel node reads. Default 4. */
  concurrency?: number;
  now?: () => number;
  /**
   * Run `retry` after `delayMs` (an incomplete pass retrying). Defaults to
   * `setTimeout`; tests inject a manual scheduler.
   */
  schedule?: (retry: () => Promise<void>, delayMs: number) => void;
  /** A retry failed for a reason other than being superseded. */
  onError?: (err: unknown) => void;
  /** A pass finished loading (`added` nodes arrived); called before a `replaced` pass retires the old view. */
  onPassComplete?: (pass: { viewEpoch: number; budget: number; points: number; added: number; replaced: boolean }) => void;
}

interface Resident {
  node: CopcLodNode;
  points: number;
  stride: number;
  /** View epoch that last wanted this node. */
  wanted: number;
}

const MAX_PAGE_ROUNDS = 8;
/** Retries of an incomplete view (failed or unfitted nodes) before waiting for the camera. */
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1_000;

/** Smallest power of two >= `stride`: small budget shifts then keep the same stride. */
export function quantizeStride(stride: number): number {
  return 2 ** Math.ceil(Math.log2(Math.max(1, stride)));
}

export class CopcLodController {
  private readonly resident = new Map<string, Resident>();
  private readonly pacer: LodPacer;
  private readonly now: () => number;
  private epoch = 0;
  private abort: AbortController | null = null;
  private displayed: LodPassQuality | null = null;
  private keep = new Map<string, number>();
  private residentPoints = 0;
  private disposed = false;
  private retries = 0;
  /** Requeues a keep-set node evicted mid-pass; set while a pass is loading. */
  private requeue: ((node: CopcLodNode) => void) | null = null;
  /** The last full-budget selection, for diagnostics. */
  lastSelection: { nodes: number; points: number; capped: boolean; needsChildren: number; pageRounds: number } | null = null;

  constructor(
    private readonly tree: CopcLodTree,
    private readonly reader: CopcLodReader,
    private readonly sink: CopcLodSink,
    private readonly options: CopcLodControllerOptions,
  ) {
    this.pacer = options.pacer ?? new LodPacer();
    this.now = options.now ?? (() => performance.now());
  }

  get points(): number {
    return this.residentPoints;
  }

  get nodeCount(): number {
    return this.resident.size;
  }

  /** Resident node ids with their strides (diagnostics and tests). */
  residentNodes(): Array<{ id: string; points: number; stride: number }> {
    return [...this.resident.values()].map((r) => ({ id: r.node.id, points: r.points, stride: r.stride }));
  }

  /**
   * Bring residency in line with `camera`. Resolves when every pass finished
   * or a newer update took over: being superseded is not an error. Rejects
   * only on a real failure (a hierarchy page that cannot be read, a sink
   * that refuses a chunk).
   */
  async update(camera: LodCamera, isRetry = false): Promise<void> {
    if (this.disposed) return;
    if (!isRetry) this.retries = 0;
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;
    const epoch = ++this.epoch;
    let complete: boolean;
    try {
      complete = await this.run(camera, epoch, abort.signal);
    } catch (err) {
      if (abort.signal.aborted) return;
      throw err;
    }
    if (complete || abort.signal.aborted || this.disposed || this.retries >= MAX_RETRIES) return;
    // Failed or unfitted nodes: try again without waiting for the camera.
    this.retries++;
    const retry = () => (this.epoch === epoch ? this.update(camera, true) : Promise.resolve());
    const schedule = this.options.schedule ?? ((run, ms) => {
      setTimeout(() => { run().catch((err: unknown) => this.options.onError?.(err)); }, ms);
    });
    schedule(retry, RETRY_DELAY_MS);
  }

  /** The passes for one view; returns whether the last pass left every selected node resident. */
  private async run(camera: LodCamera, epoch: number, signal: AbortSignal): Promise<boolean> {
    const full = await this.select(camera, this.options.pointBudget, signal);
    if (!full || signal.aborted) return true;
    this.keep = new Map(full.map(([node, stride]) => [node.id, stride]));
    for (const id of this.keep.keys()) {
      const r = this.resident.get(id);
      if (r) r.wanted = epoch;
    }
    let complete = true;
    for (const budget of this.pacer.passBudgets(this.options.pointBudget)) {
      const pass = budget >= this.options.pointBudget ? full : await this.select(camera, budget, signal);
      if (!pass || signal.aborted) return true;
      const added = await this.load(pass, epoch, signal);
      if (signal.aborted) return true;
      const points = pass.reduce((sum, [node]) => sum + (this.resident.get(node.id)?.points ?? 0), 0);
      complete = pass.every(([node, stride]) => (this.resident.get(node.id)?.stride ?? Infinity) <= stride);
      const candidate: LodPassQuality = { viewEpoch: epoch, points, complete };
      const replaced = shouldReplacePass(this.displayed, candidate);
      this.options.onPassComplete?.({ viewEpoch: epoch, budget, points, added, replaced });
      if (replaced) {
        this.displayed = candidate;
        for (const r of this.resident.values()) if (!this.keep.has(r.node.id)) this.evict(r);
      }
    }
    return complete;
  }

  /** Stop all work and drop every resident node from the sink. */
  dispose(): void {
    this.disposed = true;
    this.abort?.abort();
    for (const r of this.resident.values()) this.evict(r); // Map deletion during iteration is well-defined
  }

  /** Selection at `budget`, loading hierarchy pages the selection asks for. */
  private async select(
    camera: LodCamera,
    budget: number,
    signal: AbortSignal,
  ): Promise<Array<[CopcLodNode, number]> | null> {
    const root = this.tree.root;
    if (!root) return [];
    for (let round = 0; ; round++) {
      const selection = selectLod(root, camera, { pointBudget: budget });
      const pages = new Map<number, CopcPageRef>();
      for (const node of selection.needsChildren) {
        for (const ref of this.tree.pendingPagesUnder(node)) pages.set(ref.offset, ref);
      }
      if (pages.size === 0 || round >= MAX_PAGE_ROUNDS) {
        if (budget >= this.options.pointBudget) {
          this.lastSelection = {
            nodes: selection.nodes.length, points: selection.totalPoints, capped: selection.capped,
            needsChildren: selection.needsChildren.length, pageRounds: round,
          };
        }
        return selection.nodes.map((s) => [s.node as CopcLodNode, quantizeStride(s.stride)]);
      }
      try {
        await Promise.all([...pages.values()].map((ref) => this.reader.loadPage(ref, signal)));
      } catch (err) {
        // A page load cancelled by a newer view is not a failure.
        if (signal.aborted) return null;
        throw err;
      }
      if (signal.aborted) return null;
    }
  }

  /** Fetch the nodes of `pass` that are missing or too thin; returns how many were added. */
  private async load(pass: Array<[CopcLodNode, number]>, epoch: number, signal: AbortSignal): Promise<number> {
    const queue = pass.filter(([node, stride]) => {
      const r = this.resident.get(node.id);
      return !r || r.stride > stride;
    });
    let added = 0;
    const requeue = (node: CopcLodNode) => {
      const stride = this.keep.get(node.id);
      if (stride !== undefined && !queue.some(([queued]) => queued.id === node.id)) queue.push([node, stride]);
    };
    this.requeue = requeue;
    const worker = async () => {
      while (queue.length > 0 && !signal.aborted) {
        const [node, stride] = queue.shift() as [CopcLodNode, number];
        const started = this.now();
        let chunk: DecodedPointChunk;
        try {
          chunk = await this.reader.readNode(node.entry, { stride, signal });
        } catch (err) {
          if (signal.aborted) return;
          console.warn(`[copc-lod] node ${node.id} failed to load; skipping it this pass:`, err);
          continue;
        }
        if (signal.aborted) return;
        this.pacer.observe(chunk.pointCount, this.now() - started);
        if (this.place(node, chunk, stride, epoch)) added++;
      }
    };
    const lanes = Math.max(1, Math.floor(this.options.concurrency ?? 4));
    try {
      await Promise.all(Array.from({ length: lanes }, worker));
    } finally {
      // A superseded pass unwinds after the newer one has armed its own
      // requeue: only disarm our own.
      if (this.requeue === requeue) this.requeue = null;
    }
    return added;
  }

  /** Make room and add `chunk` for `node`, replacing a thinner resident copy. */
  private place(node: CopcLodNode, chunk: DecodedPointChunk, stride: number, epoch: number): boolean {
    const previous = this.resident.get(node.id);
    if (previous && previous.stride <= stride) return false; // a racing pass already did better
    const freed = previous?.points ?? 0;
    if (!this.makeRoom(chunk.pointCount - freed, node.id)) return false;
    if (previous) this.evict(previous);
    this.sink.append(node, chunk);
    this.resident.set(node.id, { node, points: chunk.pointCount, stride, wanted: epoch });
    this.residentPoints += chunk.pointCount;
    return true;
  }

  private makeRoom(points: number, incomingId: string): boolean {
    const budget = this.options.pointBudget;
    if (this.residentPoints + points <= budget) return true;
    const outside = [...this.resident.values()]
      .filter((r) => !this.keep.has(r.node.id) && r.node.id !== incomingId)
      .sort((a, b) => a.wanted - b.wanted || b.node.entry.key.d - a.node.entry.key.d || (a.node.id < b.node.id ? -1 : 1));
    for (const r of outside) {
      if (this.residentPoints + points <= budget) return true;
      this.evict(r);
    }
    // Last resort: keep-set nodes holding more than their current share.
    // Each is requeued into the running pass at its share's stride, so it
    // comes back thinner instead of staying missing until the camera moves.
    const fat = [...this.resident.values()]
      .filter((r) => r.node.id !== incomingId && r.stride < (this.keep.get(r.node.id) ?? Infinity))
      .sort((a, b) => b.points - a.points);
    for (const r of fat) {
      if (this.residentPoints + points <= budget) return true;
      this.evict(r);
      this.requeue?.(r.node);
    }
    return this.residentPoints + points <= budget;
  }

  private evict(r: Resident): void {
    this.sink.remove(r.node);
    this.resident.delete(r.node.id);
    this.residentPoints -= r.points;
  }
}
