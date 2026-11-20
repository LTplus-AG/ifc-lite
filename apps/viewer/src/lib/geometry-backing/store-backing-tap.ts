/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Test/debug-only ingestion of the canonical loader's output into the live
 * geometry backing. NOTHING releases CPU geometry here; product release stays
 * disabled until the parent integration consults `acknowledge`/`verify`.
 *
 * The tap mirrors each model's store mesh list, which every load path
 * (streaming, cache hit, federated finalize) and every mesh edit writes:
 * - the loader grows `models.get(id).geometryResult.meshes` IN PLACE, so a
 *   longer array with the same identity is an append: only the new suffix is
 *   written (a tap started mid-load first writes what is already resident);
 * - any other change (new array, shorter array, `geometryContentVersion` bump
 *   from realign/rebase/rotation/collab, model removal) starts a new
 *   generation from the current list, so an old disk image never answers as
 *   current geometry;
 * - instanced shards are taken from the shard queue as they are enqueued. A
 *   flat-list change (recolour copies, prune, authored mesh) leaves instanced
 *   geometry alone, so committed shards are carried into the new generation.
 *   A content-version bump may move occurrences, so a model that had shards
 *   is then reported `instancedLost` and never complete (fail closed) for the
 *   rest of this tap's life: this layer has no re-supply proof (a fresh supply
 *   stated whole and drawn is #10888's), so later shards never clear it. So is a model whose shards were
 *   enqueued before the tap started (the queue's revision is ahead of what
 *   the tap saw): those shards never reached the backing.
 * Appends for one model are chained in order; a writer failure is reported in
 * `status()` and stops that model's chain, never retried.
 *
 * Known limit, recorded for the consumer audit: geometry written into the
 * existing typed arrays without a list or content-version change (in-place
 * entity translation) is not seen here; such paths must invalidate explicitly
 * before release can rely on the backing.
 */

import { decodeInstancedShard, type DecodedInstancedShard, type MeshData } from '@ifc-lite/geometry';
import type { StoreApi } from 'zustand';
import { subscribeInstancedShards } from '@/store/instancedShardQueue';
import { instancedShardRevision } from '@/store/instancedShardModels';
import { isReleasedMesh } from '@/lib/released-mesh-provenance';
import { GeometryBackingRegistry, type ModelBackingOptions, type ModelGeometryBacking } from './geometry-backing-registry';
import type { BackingDatabaseOptions } from './backing-database';

/** The store fields the tap reads. */
export interface TapState {
  models: ReadonlyMap<string, { geometryResult: { meshes: MeshData[] } | null }>;
  geometryContentVersion: number;
}

interface Tracked {
  backing?: ModelGeometryBacking;
  meshes: MeshData[] | undefined;
  consumed: number;
  chain: Promise<void>;
  failure?: Error;
  instancedLost: boolean;
  shards: number;
  /** The store list changed after a CPU release: this generation is kept durable but no longer answers. */
  stale?: Error;
  /** Replaced (or removed) before its generation began: superseded as soon as it does. */
  replaced?: boolean;
  /** A carry of the predecessor's shards is still pending: they count as this generation's shards. */
  carrying?: boolean;
  /** The store has listed this model: only then can its absence mean a removal (a shard may arrive first). */
  registered?: boolean;
  /** A seal acknowledged (or is acknowledging) this generation: its writer is closed to further appends. */
  sealed?: boolean;
}

export interface ModelBackingStatus {
  modelId: string;
  generation: number;
  meshes: number;
  chunks: number;
  shards: number;
  storedBytes: number;
  pendingBytes: number;
  complete: boolean;
  instancedLost: boolean;
  error?: string;
}

const APPEND_BATCH = 256;

export class StoreGeometryBackingTap {
  private readonly tracked = new Map<string, Tracked>();
  private contentVersion: number;
  private readonly stops: Array<() => void> = [];
  /** Shard enqueue events seen per model since start, compared with the queue's revision. */
  private readonly shardEvents = new Map<string, number>();
  private stopped = false;
  /** Deferred cleanups of removed models' generations, awaited by `whenIdle`. */
  private readonly removals = new Set<Promise<void>>();

  private constructor(
    private readonly registry: GeometryBackingRegistry,
    store: StoreApi<TapState>, // read once here; the store subscription in `start` drives every sync
    private readonly options: ModelBackingOptions,
  ) {
    this.contentVersion = store.getState().geometryContentVersion;
  }

  static async start(store: StoreApi<TapState>, options: ModelBackingOptions & { database?: BackingDatabaseOptions } = {}):
    Promise<StoreGeometryBackingTap> {
    const registry = await GeometryBackingRegistry.open(options.database);
    const tap = new StoreGeometryBackingTap(registry, store, options);
    tap.stops.push(store.subscribe((state) => tap.sync(state)));
    tap.stops.push(subscribeInstancedShards((event) => {
      if (event.kind !== 'enqueued' || !event.shards) return;
      for (const modelId of event.modelIds) tap.shardEvents.set(modelId, (tap.shardEvents.get(modelId) ?? 0) + 1);
      for (const shard of event.shards) tap.ingestShard(shard.modelId, shard.bytes);
    }));
    tap.sync(store.getState());
    return tap;
  }

  get registryHandle(): GeometryBackingRegistry { return this.registry; }

  /** The model's current backing generation, for readback consumers. */
  backing(modelId: string): ModelGeometryBacking | undefined {
    const tracked = this.tracked.get(modelId);
    return tracked && !tracked.stale ? tracked.backing : undefined;
  }

  private sync(state: TapState): void {
    if (this.stopped) return;
    const versionChanged = state.geometryContentVersion !== this.contentVersion;
    this.contentVersion = state.geometryContentVersion;
    for (const [modelId, model] of state.models) {
      const meshes = model.geometryResult?.meshes;
      const tracked = this.tracked.get(modelId);
      if (tracked) tracked.registered = true;
      if (!tracked) {
        // A list already released when the tap first sees it (a restart after release-for-test) has no
        // arrays to back: never back its empty records as a generation.
        if (meshes?.some(isReleasedMesh)) {
          const stale = new Error('The store list was released before the tap saw it; nothing can be backed');
          this.tracked.set(modelId, { meshes, consumed: meshes.length, chain: Promise.resolve(), instancedLost: false, shards: 0, stale });
          console.error(`[GeometryBacking] ${modelId}: ${stale.message}`);
        } else this.regenerate(modelId, meshes, 'none');
        this.tracked.get(modelId)!.registered = true;
        continue;
      }
      // A content change loses committed instancing until re-supply is proved, on EVERY path, including the
      // stale and released-list exits below that build no successor now: a later carry must not revive it.
      if (versionChanged && (tracked.shards > 0 || tracked.carrying)) tracked.instancedLost = true;
      // First geometry of a model whose shards arrived earlier: an append.
      if (!versionChanged && tracked.meshes === undefined && tracked.consumed === 0 && meshes) tracked.meshes = meshes;
      // A stale (released) generation answers nothing; only a fresh resident list may replace it.
      if (tracked.stale && !(meshes && meshes !== tracked.meshes && meshes.length > 0 && !meshes.some(isReleasedMesh))) continue;
      if (versionChanged || meshes !== tracked.meshes || (meshes && meshes.length < tracked.consumed)) {
        // A released list has no arrays to back, and a new generation would delete the
        // acknowledged one: keep that durable, stop answering from it, never back empties.
        if (meshes?.some(isReleasedMesh)) {
          tracked.stale = new Error('The store list changed after a CPU release; its backing no longer answers');
          this.supersede(tracked); // retained handles too: not current, its old bytes durable for the tap alone
          console.error(`[GeometryBacking] ${modelId}: ${tracked.stale.message}`);
          continue;
        }
        const hadShards = tracked.shards > 0 || tracked.instancedLost || !!tracked.carrying;
        this.regenerate(modelId, meshes, !hadShards ? 'none' : versionChanged ? 'lost' : 'carry');
        continue;
      }
      if (meshes && meshes.length > tracked.consumed) {
        if (meshes.slice(tracked.consumed).some(isReleasedMesh)) {
          tracked.stale = new Error('Released meshes were appended; they have no arrays to back');
          this.supersede(tracked);
          console.error(`[GeometryBacking] ${modelId}: ${tracked.stale.message}`);
          continue;
        }
        // A sealed generation's writer is closed: an in-place append after the seal starts a successor
        // with the whole list (the acknowledged one is superseded at once, never left verifying without it).
        if (tracked.sealed) {
          const hadShards = tracked.shards > 0 || tracked.instancedLost || !!tracked.carrying;
          this.regenerate(modelId, meshes, hadShards ? 'carry' : 'none');
        } else this.appendSuffix(tracked, meshes);
      }
    }
    for (const modelId of [...this.tracked.keys()]) {
      // A generation begun by a shard that arrived before its model was registered waits for the model.
      if (!state.models.has(modelId) && this.tracked.get(modelId)?.registered) this.drop(modelId, 'Model was removed');
    }
  }

  /** The store replaced this generation's geometry: not current from now on, even before its successor begins. */
  private supersede(tracked: Tracked | undefined): void {
    if (!tracked) return;
    if (tracked.backing) tracked.backing.supersede(); else tracked.replaced = true;
  }

  /**
   * The only place a successor generation is built. Released arrays are terminal: a successor built from
   * them would persist zero-length meshes and replace the backing that holds the real geometry. Refuse,
   * leave the acknowledged generation durable (it stops answering: it lacks what arrived), and report false.
   */
  private regenerate(modelId: string, meshes: MeshData[] | undefined, shards: 'none' | 'carry' | 'lost'): boolean {
    const previous = this.tracked.get(modelId);
    if (meshes?.some(isReleasedMesh)) {
      if (previous) {
        previous.stale ??= new Error('Geometry arrived for a model whose CPU geometry was released; a fresh load must register it again');
        this.supersede(previous);
        console.error(`[GeometryBacking] ${modelId}: ${previous.stale.message}`);
      }
      return false;
    }
    this.supersede(previous);
    const next: Tracked = { meshes, consumed: 0, chain: Promise.resolve(), instancedLost: shards === 'lost', shards: 0, carrying: shards === 'carry',
      registered: previous?.registered };
    const begun = (previous?.chain ?? Promise.resolve()).then(async () => {
      // Read committed shards before `begin` deletes the previous generation (its own carry has run).
      const carried: DecodedInstancedShard[] = [];
      if (shards === 'carry') {
        if (!previous?.backing || previous.failure || previous.instancedLost) next.instancedLost = true;
        else for await (const shard of previous.backing.carryReader.instancedShards()) carried.push(shard);
      }
      next.backing = await this.registry.begin(modelId, this.options);
      if (next.replaced) next.backing.supersede(); // replaced again before it began
      for (const shard of carried) {
        next.shards++;
        await next.backing.writer.appendInstancedShard(shard);
      }
      next.carrying = false;
    });
    next.chain = this.settle(next, begun);
    this.tracked.set(modelId, next);
    if (meshes && meshes.length > 0) this.appendSuffix(next, meshes);
    return true;
  }

  private writer(tracked: Tracked): ModelGeometryBacking['writer'] {
    if (!tracked.backing) throw new Error('Geometry backing generation was not started');
    return tracked.backing.writer;
  }

  private appendSuffix(tracked: Tracked, meshes: MeshData[]): void {
    const from = tracked.consumed, to = meshes.length;
    tracked.consumed = to;
    // Snapshot the suffix now: the array keeps growing in place.
    const slice = meshes.slice(from, to);
    this.enqueue(tracked, async () => {
      for (let i = 0; i < slice.length; i += APPEND_BATCH) {
        await this.writer(tracked).append(slice.slice(i, i + APPEND_BATCH));
      }
    });
  }

  private ingestShard(modelId: string, bytes: ArrayBuffer): void {
    if (this.stopped) return;
    let tracked = this.tracked.get(modelId);
    if (!tracked) {
      this.regenerate(modelId, undefined, 'none');
      tracked = this.tracked.get(modelId)!;
    }
    // A stale generation answers nothing and takes nothing more (released arrays are terminal).
    if (tracked.stale) return;
    // A sealed generation's writer is closed and its acknowledgement must stop verifying NOW, not when the
    // deferred append runs: supersede it and stage a successor (its shards carried) for this one.
    if (tracked.sealed) {
      if (!this.regenerate(modelId, tracked.meshes, 'carry')) return;
      tracked = this.tracked.get(modelId)!;
    }
    const target = tracked;
    target.shards++;
    // Decode a private copy: the drain may transfer or reuse the queued bytes. A shard that does not decode
    // is a failure of this generation (never acknowledged), not an exception that skips it unrecorded.
    let shard: DecodedInstancedShard;
    try { shard = decodeInstancedShard(bytes.slice(0)); } catch (error) {
      void this.settle(target, Promise.reject(error));
      return;
    }
    this.enqueue(target, () => this.writer(target).appendInstancedShard(shard));
  }

  private enqueue(tracked: Tracked, step: () => Promise<void>): void {
    tracked.chain = this.settle(tracked, tracked.chain.then(() => {
      if (tracked.failure) return undefined;
      return step();
    }));
  }

  /** Record the first failure per generation; later steps are skipped, not retried. */
  private settle(tracked: Tracked, step: Promise<void>): Promise<void> {
    return step.then(undefined, (error: unknown) => {
      if (tracked.failure) return;
      tracked.failure = error instanceof Error ? error : new Error(String(error));
      console.error('[GeometryBacking] model backing failed; CPU geometry must stay resident', tracked.failure);
    });
  }

  private drop(modelId: string, reason: string): void {
    const tracked = this.tracked.get(modelId);
    if (!tracked) return;
    this.tracked.delete(modelId);
    this.supersede(tracked); // a retained handle stops being current now, not once the pending append ends
    // Retire exactly this generation (a re-added model's must survive); whenIdle waits for it.
    const removal = this.settle(tracked, tracked.chain.then(() => (tracked.backing ? this.registry.retire(tracked.backing, reason) : undefined)));
    this.removals.add(removal);
    void removal.then(() => { this.removals.delete(removal); });
  }

  /** Resolve once every queued append has been handed to its writer. */
  async whenIdle(): Promise<void> {
    // Steps may enqueue more steps or regenerate; settle until nothing moved.
    for (;;) {
      const chains = [...[...this.tracked.values()].map((tracked) => tracked.chain), ...this.removals];
      await Promise.all(chains);
      const now = [...[...this.tracked.values()].map((tracked) => tracked.chain), ...this.removals];
      if (now.length === chains.length && now.every((chain, i) => chain === chains[i])) return;
    }
  }

  /** Close every model's writer and acknowledge complete generations. */
  async seal(): Promise<ModelBackingStatus[]> {
    await this.whenIdle();
    for (const [modelId, tracked] of this.tracked) {
      // No geometry yet (`geometryResult: null` before the first batch) is not an empty model: never acknowledged.
      if (tracked.failure || tracked.instancedLost || this.missedShards(modelId) || !tracked.backing || tracked.meshes === undefined) continue;
      tracked.sealed = true;
      await this.settle(tracked, tracked.backing.acknowledge().then(() => undefined));
    }
    return this.status();
  }

  /**
   * The release allowlist (#10876): the model's current generation and the exact list it verified, only
   * when it is registered, sealed, idle-complete (every listed mesh consumed, no shard pending, carried
   * or missed), current, not stale or failed, and backs resident arrays. Anything else: undefined.
   */
  releaseCandidate(modelId: string): { backing: ModelGeometryBacking; meshes: MeshData[] } | undefined {
    const tracked = this.tracked.get(modelId);
    const backing = tracked?.backing, meshes = tracked?.meshes;
    if (!tracked || !backing || !meshes || !tracked.registered || !tracked.sealed || tracked.stale || tracked.failure
      || tracked.instancedLost || tracked.carrying || tracked.replaced || this.missedShards(modelId)) return undefined;
    if (!backing.isCurrent || !backing.isComplete || tracked.consumed !== meshes.length || meshes.some(isReleasedMesh)) return undefined;
    return { backing, meshes };
  }

  /** Shards were enqueued for this model that the tap never saw. */
  private missedShards(modelId: string): boolean {
    return instancedShardRevision(modelId) > (this.shardEvents.get(modelId) ?? 0);
  }

  status(): ModelBackingStatus[] {
    return [...this.tracked].map(([modelId, tracked]) => {
      const backing = tracked.backing;
      const instancedLost = tracked.instancedLost || this.missedShards(modelId);
      const error = tracked.stale ?? tracked.failure ?? backing?.writer.error;
      return {
        modelId, generation: backing?.generation ?? 0, meshes: tracked.consumed,
        chunks: backing?.directory.chunks.length ?? 0, shards: backing?.directory.shards.length ?? 0,
        storedBytes: backing?.directory.storedBytes ?? 0, pendingBytes: backing?.writer.pendingBytes ?? 0,
        complete: !!backing?.isComplete && !instancedLost && !tracked.failure && !tracked.stale && tracked.meshes !== undefined,
        instancedLost, ...(error ? { error: `${error.name}: ${error.message}` } : {}),
      };
    });
  }

  /** Stop observing and delete this page's backing. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const stop of this.stops.splice(0)) stop();
    // Every owned chain AND every pending removal's retirement (their deletes included) before the registry
    // and its database close: a deferred delete after close would leave orphan records. Failures are settled.
    await this.whenIdle();
    this.tracked.clear();
    await this.registry.close();
  }
}
