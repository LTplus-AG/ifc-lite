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
    const pieces = split(mesh);
    // An index-less mesh over the vertex-byte limit splits into no piece; an empty group cannot be uploaded.
    if (pieces.length === 0) continue;
    const key = keyOf(mesh);
    let group = groups.get(key);
    if (!group) groups.set(key, (group = []));
    for (const piece of pieces) {
      if (piece !== mesh) sourceOf.set(piece, mesh);
      group.push(piece);
    }
  }
  return { groups, sourceOf };
}

/** The pieces one batch draws, so a partial batch cut from it draws only those. */
export interface BatchPieces {
  readonly batch: BatchedMesh;
  /** Holds a colour-merged mesh, registered under every id it carries: a subset
   *  split would put it in more than one subset (see `Scene.canPartitionBatch`). */
  readonly colorMerged: boolean;
  /** Add this batch's pieces of the registered mesh `mesh` to `into`. */
  collect(mesh: MeshData, into: Set<MeshData>): void;
}

/** What one streaming fragment was uploaded from. */
export class FragmentPieces implements BatchPieces {
  /** Registered meshes uploaded whole: their own piece. */
  private readonly whole = new Set<MeshData>();
  /** Registered meshes split for streaming: this fragment's pieces of each. */
  private readonly split = new Map<MeshData, MeshData[]>();
  readonly colorMerged: boolean = false;

  constructor(readonly batch: BatchedMesh, pieces: readonly MeshData[], sourceOf: ReadonlyMap<MeshData, MeshData>) {
    for (const piece of pieces) {
      const source = sourceOf.get(piece);
      if ((source ?? piece).entityIds?.length) this.colorMerged = true;
      const list = source && this.split.get(source);
      if (!source) this.whole.add(piece);
      else if (list) list.push(piece);
      else this.split.set(source, [piece]);
    }
  }

  collect(mesh: MeshData, into: Set<MeshData>): void {
    if (this.whole.has(mesh)) {
      into.add(mesh);
      return;
    }
    for (const piece of this.split.get(mesh) ?? []) {
      // A model translation re-places the registered mesh, not the copies cut from it.
      piece.origin = mesh.origin;
      piece.localToWorld = mesh.localToWorld;
      piece.geometryAabb = mesh.geometryAabb;
      into.add(piece);
    }
  }
}

/**
 * What a bucket's built batch was uploaded from: its bucket's meshes at the
 * moment the bucket first outgrew it (#9270). The batch keeps drawing exactly
 * these until finalize replaces it, while the meshes added since are drawn by
 * streaming fragments, or by nothing yet. Built lazily: most such batches are
 * never cut into a partial before they are replaced.
 */
export class BuiltBatchPieces implements BatchPieces {
  private held?: Set<MeshData>;
  private merged?: boolean;

  /** @param meshes A copy of the bucket's meshes, taken before the first mesh the batch does not hold joins it. */
  constructor(readonly batch: BatchedMesh, private readonly meshes: readonly MeshData[]) {}

  get colorMerged(): boolean {
    return (this.merged ??= this.meshes.some((mesh) => (mesh.entityIds?.length ?? 0) > 0));
  }

  collect(mesh: MeshData, into: Set<MeshData>): void {
    if ((this.held ??= new Set(this.meshes)).has(mesh)) into.add(mesh);
  }
}

/**
 * The pieces each streaming fragment was uploaded from, so its partial batch
 * draws only those (#9081): fragments of one bucket share it, and after a
 * finalize regroup the bucket may hold other meshes. Likewise the pieces of a
 * built bucket batch whose bucket gained meshes it does not hold (#9270).
 *
 * Keyed by batch id because a partial request names its source batch only by
 * its slot key, `${colorKey}:${id}` plus an optional slot suffix (the same
 * convention `dropPartialCacheForBatch` relies on).
 */
export class StreamingFragmentPieces {
  private readonly byBatchId = new Map<number, BatchPieces>();

  /**
   * @param pieces What the fragment was uploaded from.
   * @param sourceOf The registered (`meshDataMap`) mesh each split piece was cut from.
   */
  record(fragment: BatchedMesh, pieces: readonly MeshData[], sourceOf: ReadonlyMap<MeshData, MeshData>): void {
    this.byBatchId.set(fragment.id, new FragmentPieces(fragment, pieces, sourceOf));
  }

  /**
   * Call before a mesh the bucket's built batch does not hold joins the bucket,
   * while that batch draws on until a finalize swap replaces it: records what
   * the batch holds. Only the first call per batch records; after that the
   * bucket has outgrown it. A bucket with no built batch has nothing to record.
   */
  recordBuilt(bucket: { readonly batchedMesh: BatchedMesh | null; readonly meshData: readonly MeshData[] }): void {
    const batch = bucket.batchedMesh;
    if (batch && this.byBatchId.get(batch.id)?.batch !== batch) this.byBatchId.set(batch.id, new BuiltBatchPieces(batch, bucket.meshData.slice()));
  }

  /** `batch`'s record, or `undefined` when it has none. */
  forBatch(batch: BatchedMesh): BatchPieces | undefined {
    const record = this.byBatchId.get(batch.id);
    return record?.batch === batch ? record : undefined;
  }

  /** The slot's batch record, or `undefined` when the slot's batch has none. */
  forSlot(sourceBatchKey: string, colorKey: string): BatchPieces | undefined {
    if (!sourceBatchKey.startsWith(`${colorKey}:`)) return undefined;
    return this.byBatchId.get(Number.parseInt(sourceBatchKey.slice(colorKey.length + 1), 10));
  }

  /** Forget every batch but `live`: at each finalize swap, `finishEphemeralStreaming`, `clear()` and device recovery. */
  retainOnly(live: readonly BatchedMesh[]): void {
    if (this.byBatchId.size === 0) return;
    const keep = new Set(live.map((batch) => batch.id));
    for (const id of this.byBatchId.keys()) if (!keep.has(id)) this.byBatchId.delete(id);
  }
}
