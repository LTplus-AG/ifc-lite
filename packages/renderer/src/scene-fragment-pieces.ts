/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MeshData } from '@ifc-lite/geometry';
import type { BatchedMesh } from './types.js';

/**
 * Group an append's meshes by owning bucket key, split for streaming. Pieces of
 * one mesh share the PARENT's key: they are vertex subsets of the same element,
 * and the mesh-never-splits rule applies to cells exactly like it does to buckets.
 * `sourceOf` maps each split piece to its mesh, for {@link StreamingFragmentPieces.record}.
 */
export function groupStreamingPieces(
  meshes: readonly MeshData[],
  keyOf: (mesh: MeshData) => string,
  split: (mesh: MeshData) => MeshData[],
): { groups: Map<string, MeshData[]>; sourceOf: Map<MeshData, MeshData> } {
  const groups = new Map<string, MeshData[]>();
  const sourceOf = new Map<MeshData, MeshData>();
  for (const mesh of meshes) {
    const key = keyOf(mesh);
    let group = groups.get(key);
    if (!group) groups.set(key, (group = []));
    for (const piece of split(mesh)) {
      if (piece !== mesh) sourceOf.set(piece, mesh);
      group.push(piece);
    }
  }
  return { groups, sourceOf };
}

/** What one streaming fragment was uploaded from. */
export class FragmentPieces {
  /** Registered meshes uploaded whole: their own piece. */
  private readonly whole = new Set<MeshData>();
  /** Registered meshes split for streaming: this fragment's pieces of each. */
  private readonly split = new Map<MeshData, MeshData[]>();

  constructor(readonly fragment: BatchedMesh, pieces: readonly MeshData[], sourceOf: ReadonlyMap<MeshData, MeshData>) {
    for (const piece of pieces) {
      const source = sourceOf.get(piece);
      const list = source && this.split.get(source);
      if (!source) this.whole.add(piece);
      else if (list) list.push(piece);
      else this.split.set(source, [piece]);
    }
  }

  /** Append this fragment's pieces of the registered mesh `mesh` to `into`. */
  collect(mesh: MeshData, into: MeshData[]): void {
    if (this.whole.has(mesh)) into.push(mesh);
    else into.push(...(this.split.get(mesh) ?? []));
  }
}

/**
 * The pieces each streaming fragment was uploaded from, so its partial batch
 * draws only those (#9081): fragments of one bucket share it, and after a
 * finalize regroup the bucket may hold other meshes.
 *
 * Keyed by batch id because a partial request names its source batch only by
 * its slot key, `${colorKey}:${id}` plus an optional slot suffix (the same
 * convention `dropPartialCacheForBatch` relies on).
 */
export class StreamingFragmentPieces {
  private readonly byBatchId = new Map<number, FragmentPieces>();

  /**
   * @param pieces What the fragment was uploaded from.
   * @param sourceOf The registered (`meshDataMap`) mesh each split piece was cut from.
   */
  record(fragment: BatchedMesh, pieces: readonly MeshData[], sourceOf: ReadonlyMap<MeshData, MeshData>): void {
    this.byBatchId.set(fragment.id, new FragmentPieces(fragment, pieces, sourceOf));
  }

  /** The slot's fragment record, or `undefined` when the slot's batch is not a recorded fragment. */
  forSlot(sourceBatchKey: string, colorKey: string): FragmentPieces | undefined {
    if (!sourceBatchKey.startsWith(`${colorKey}:`)) return undefined;
    return this.byBatchId.get(Number.parseInt(sourceBatchKey.slice(colorKey.length + 1), 10));
  }

  /** Forget every fragment but `live`: at each finalize swap, `finishEphemeralStreaming`, `clear()` and device recovery. */
  retainOnly(live: readonly BatchedMesh[]): void {
    if (this.byBatchId.size === 0) return;
    const keep = new Set(live.map((fragment) => fragment.id));
    for (const id of this.byBatchId.keys()) if (!keep.has(id)) this.byBatchId.delete(id);
  }
}
