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
 * subtree instead of its proxy. The cost is the full detail of the batches
 * that hold the selection, nothing else.
 */
import { PartDraw, type LodPart } from './lod-parts.js';
import type { BatchedMesh } from './types.js';

const NONE: ReadonlySet<BatchedMesh> = new Set();

/** Where each batch holding one of the ids sits in the list, scanning entries and lane ids. */
function holding(list: readonly BatchedMesh[], has: (id: number) => boolean): Map<BatchedMesh, number> {
  const held = new Map<BatchedMesh, number>();
  for (let index = 0; index < list.length; index++) {
    const batch = list[index]!;
    if (batch.expressIds.some(has) || batch.laneIds?.some(has)) held.set(batch, index);
  }
  return held;
}

/** One cached choice: rescanned when its ids, the batch list or the pick geometry moved, or a held batch was swapped in place. */
class Held {
  private list: readonly BatchedMesh[] | null = null;
  private length = 0;
  private revision = -1;
  private key: unknown = undefined;
  batches = new Map<BatchedMesh, number>();

  /** Whether the choice changed. */
  update(list: readonly BatchedMesh[], revision: number, key: unknown, has: ((id: number) => boolean) | null): boolean {
    if (key === this.key && list === this.list && list.length === this.length && revision === this.revision && this.current(list)) return false;
    this.key = key; this.list = list; this.length = list.length; this.revision = revision;
    this.batches = has ? holding(list, has) : new Map();
    return true;
  }

  private current(list: readonly BatchedMesh[]): boolean {
    for (const [batch, index] of this.batches) if (list[index] !== batch) return false;
    return true;
  }
}

export class FullDetailBatches {
  private readonly selected = new Held();
  private readonly hovered = new Held();
  private set: ReadonlySet<BatchedMesh> = NONE;

  /**
   * The batches holding an id of `selected` or `hovered`, in any model (a wider
   * set only costs detail). The same set object while nothing changed, so a
   * consumer may cache what it derives from it. The selection and the hover are
   * kept apart: moving the pointer never rescans a large selection.
   */
  resolve(list: readonly BatchedMesh[], revision: number, selected: ReadonlySet<number>, hovered: number | null): ReadonlySet<BatchedMesh> {
    const a = this.selected.update(list, revision, selected, selected.size > 0 ? (id) => selected.has(id) : null);
    const b = this.hovered.update(list, revision, hovered, hovered !== null ? (id) => id === hovered : null);
    if (a || b) {
      const s = this.selected.batches, h = this.hovered.batches;
      this.set = s.size + h.size === 0 ? NONE : new Set([...s.keys(), ...h.keys()]);
    }
    return this.set;
  }
}

/** `choose` for a batch drawn at full detail: a part it would draw at LOD1 draws LOD0 (a culled part stays culled). */
export function fullDetailParts(choose: (part: LodPart) => PartDraw): (part: LodPart) => PartDraw {
  return (part) => {
    const draw = choose(part);
    return draw === PartDraw.Lod1 ? PartDraw.Lod0 : draw;
  };
}
