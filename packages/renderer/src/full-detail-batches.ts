/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The batches drawn at full detail this frame: those holding a selected or
 * hovered entity.
 *
 * The selection highlight, its masks and the hover outline redraw such an
 * entity from its LOD0 triangles with `greater-equal` and no depth bias, so
 * they tie with its base draw only when that draw is the same triangles. LOD1
 * is other triangles: vertex clustering (`lod-simplify.ts`) moves each kept
 * triangle's corners to its cells' representatives. So is an HLOD proxy
 * (`draw-stream-hlod.ts`), a clustered stand-in for a whole region. Wherever
 * either lies in front of LOD0, the base colour shows through the highlight.
 * These batches therefore never draw LOD1, and an HLOD node over one draws its
 * subtree instead of its proxy.
 *
 * The cost is the full detail of the batches that hold the highlight, and it is
 * not bounded: selecting everything turns LOD1 and HLOD off for every batch
 * holding a selected entity (`FrameStats.batchesFullDetail` counts them).
 * Capping it would bring the base colour back through the highlight.
 */
import { PartDraw, type LodPart } from './lod-parts.js';
import type { BatchedMesh } from './types.js';

/** One highlight source's batches (the selection's, or the hover's): a new object whenever they change, so derived data can be cached on it. */
export class FullDetailPart implements Iterable<BatchedMesh> {
  /** Weak, like the rest of this module: an unloaded model's batches are never kept alive by a highlight that last saw them. */
  private readonly members = new WeakSet<BatchedMesh>();
  private readonly refs: [WeakRef<BatchedMesh>, number][] = [];

  constructor(held: Iterable<readonly [BatchedMesh, number]>) {
    for (const [batch, index] of held) { this.members.add(batch); this.refs.push([new WeakRef(batch), index]); }
  }

  get size(): number { return this.refs.length; }
  has(batch: BatchedMesh): boolean { return this.members.has(batch); }

  *[Symbol.iterator](): Iterator<BatchedMesh> {
    for (const [ref] of this.refs) { const batch = ref.deref(); if (batch) yield batch; }
  }

  /** Whether every batch still sits where it was found (not swapped in place by a residency restore or recovery). */
  current(list: readonly BatchedMesh[]): boolean {
    for (const [ref, index] of this.refs) { const batch = ref.deref(); if (!batch || list[index] !== batch) return false; }
    return true;
  }
}

const NO_PART = new FullDetailPart([]);

/**
 * The batches (and their list index) holding one of `ids`: from the scene's entity -> batch index when the
 * caller keeps one (`batch-highlight.ts`), else one scan of the batch entries.
 */
export type BatchesHolding = (list: readonly BatchedMesh[], ids: ReadonlySet<number>) => Iterable<readonly [BatchedMesh, number]>;

/** Scan every batch's entries and lane ids: O(entries), the fallback without an index. */
export function scanBatchesHolding(list: readonly BatchedMesh[], ids: ReadonlySet<number>): Array<[BatchedMesh, number]> {
  const out: Array<[BatchedMesh, number]> = [];
  const has = (id: number): boolean => ids.has(id);
  for (let index = 0; index < list.length; index++) {
    const batch = list[index]!;
    if (batch.expressIds.some(has) || batch.laneIds?.some(has)) out.push([batch, index]);
  }
  return out;
}

/** One cached source: looked up again when its ids, the batch list or the pick geometry moved, or a held batch was swapped in place. */
class Source {
  private list: WeakRef<readonly BatchedMesh[]> | null = null;
  private length = 0;
  private revision = -1;
  private ids: ReadonlySet<number> | null = null;
  private idCount = 0;
  part: FullDetailPart = NO_PART;

  update(list: readonly BatchedMesh[], revision: number, ids: ReadonlySet<number>, lookup: BatchesHolding): void {
    if (ids === this.ids && ids.size === this.idCount && list === this.list?.deref() && list.length === this.length && revision === this.revision && this.part.current(list)) return;
    this.list = new WeakRef(list); this.length = list.length; this.revision = revision; this.ids = ids; this.idCount = ids.size;
    this.part = ids.size === 0 ? NO_PART : new FullDetailPart(lookup(list, ids));
  }
}

const NO_IDS: ReadonlySet<number> = new Set();

export class FullDetailBatches {
  private readonly selection = new Source();
  private readonly hover = new Source();
  private hoveredId: number | null = null;
  private hoveredIds: ReadonlySet<number> = NO_IDS;

  /**
   * Bring the selection's and the hover's batches up to date (in any model: a wider set only costs detail).
   * `selected` is compared by identity (and size): pass a new set for a new selection, as `SelectionSnapshot` does.
   * They are kept apart, so moving the pointer never looks up a large selection again, and each part keeps
   * its identity while unchanged. Returns this, for its `has` and `parts`.
   */
  resolve(list: readonly BatchedMesh[], revision: number, selected: ReadonlySet<number>, hovered: number | null, lookup: BatchesHolding = scanBatchesHolding): this {
    if (hovered !== this.hoveredId) { this.hoveredId = hovered; this.hoveredIds = hovered === null ? NO_IDS : new Set([hovered]); }
    this.selection.update(list, revision, selected, lookup);
    this.hover.update(list, revision, this.hoveredIds, lookup);
    return this;
  }

  has(batch: BatchedMesh): boolean { return this.selection.part.has(batch) || this.hover.part.has(batch); }
  /** The selection's part, then the hover's. */
  get parts(): readonly FullDetailPart[] { return [this.selection.part, this.hover.part]; }
  /** Batches held at full detail. */
  get size(): number {
    let hoverOnly = 0;
    for (const batch of this.hover.part) if (!this.selection.part.has(batch)) hoverOnly++;
    return this.selection.part.size + hoverOnly;
  }
}

/** `choose` for a batch drawn at full detail: a part it would draw at LOD1 draws LOD0 (a culled part stays culled). */
export function fullDetailParts(choose: (part: LodPart) => PartDraw): (part: LodPart) => PartDraw {
  return (part) => {
    const draw = choose(part);
    return draw === PartDraw.Lod1 ? PartDraw.Lod0 : draw;
  };
}
