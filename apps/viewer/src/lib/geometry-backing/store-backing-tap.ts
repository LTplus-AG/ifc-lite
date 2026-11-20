/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Test/debug-only ingestion of the canonical loader's output into the live geometry backing
 * (#10264). NOTHING releases CPU geometry here; product release stays off.
 *
 * Each model's store mesh list is mirrored: an in-place grow is an append (only the suffix is
 * written); any other change (new or shorter array, a content-version bump, removal) starts a new
 * generation, staged beside the acknowledged one until a seal acknowledges it complete. Instanced
 * shards are taken from the shard queue as enqueued; the backing holds exactly the shards the
 * scene drew (a dropped or discarded one is withheld). A content bump may move occurrences, so
 * instancing is then lost until its model states a fresh set whole (`instanced-resupply.ts`); so
 * is a model whose shards were enqueued before the tap started. A writer failure stops that
 * model's chain and is reported in `status()`, never retried.
 *
 * Known limit, for the consumer audit: geometry rewritten in the existing typed arrays with no
 * list or content-version change is not seen here; such paths must invalidate explicitly.
 */

import { decodeInstancedShard, type DecodedInstancedShard, type MeshData } from '@ifc-lite/geometry';
import type { StoreApi } from 'zustand';
import { type InstancedShardSupply, instancedShardGeneration, instancedShardModelEpoch, subscribeInstancedShards, subscribeInstancedShardSupply } from '@/store/instancedShardQueue';
import { instancedShardRevision } from '@/store/instancedShardModels';
import { isReleasedMesh } from '@/lib/released-mesh-provenance';
import { applyFederationOffsetToShard } from '@/components/viewer/instancedFederationOffset';
import { collectMeshAreas, type MeshAreaEntry } from '@/components/viewer/tools/measure-modes/mesh-area';
import { acceptStatement, admitShard, type ResupplyState, statementVoided, supplyPoint, type SupplyPoint } from './instanced-resupply';
import { notifyReleasedGeometryMetadataChanged, setReleasedGeometryMetadata } from './released-geometry-metadata';
import { type PreviousGeneration, replayStoreList } from './generation-replay';
import { GeometryBackingRegistry, type ModelBackingOptions, type ModelGeometryBacking } from './geometry-backing-registry';
import type { BackingDatabaseOptions } from './backing-database';

/** The store fields the tap reads. */
export interface TapState {
  models: ReadonlyMap<string, { geometryResult: { meshes: MeshData[] } | null; idOffset?: number }>;
  geometryContentVersion: number;
}

interface Tracked extends ResupplyState {
  /** Registry key of this generation: generations stage side by side. */
  key: string;
  backing?: ModelGeometryBacking;
  /** Per-model generation number (1 for a model's first generation). */
  number: number;
  /** Generations kept until this one is acknowledged complete and current. */
  retained: string[];
  meshes: MeshData[] | undefined;
  /** Immutable snapshot of the store meshes this generation holds, in record order. The store
   * array itself may be spliced in place later; replay must not read membership from it. */
  members: MeshData[];
  consumed: number;
  chain: Promise<void>;
  failure?: Error;
  shards: number;
  sources: (ArrayBuffer | null)[]; // the queued bytes each backed shard came from, in backed order
  /** Instanced occurrences backed; empty shard records are not instancing. */
  occurrences: number;
  /** The store list changed after a CPU release: this generation is kept durable but no longer answers. */
  stale?: Error;
  /** Per-entity mesh area of this generation, summed as `collectMeshAreas` sums the whole list. */
  areas: Map<number, MeshAreaEntry>;
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
  private sequence = 0;
  /** Per model, the last generation acknowledged complete: the only replay source. */
  private readonly acknowledged = new Map<string, Tracked>();
  private stopped = false;

  private constructor(
    private readonly registry: GeometryBackingRegistry,
    private readonly store: StoreApi<TapState>,
    private readonly options: ModelBackingOptions,
  ) {
    this.contentVersion = store.getState().geometryContentVersion;
  }

  static async start(store: StoreApi<TapState>, options: ModelBackingOptions & { database?: BackingDatabaseOptions } = {}):
    Promise<StoreGeometryBackingTap> {
    const registry = await GeometryBackingRegistry.open(options.database);
    const tap = new StoreGeometryBackingTap(registry, store, options);
    tap.stops.push(store.subscribe((state) => tap.sync(state)));
    tap.stops.push(subscribeInstancedShardSupply((supply) => tap.onSupply(supply)));
    tap.stops.push(subscribeInstancedShards((event) => {
      // Dropped or discarded before upload: the backing must hold exactly what the scene drew. A full
      // discard (a reset) moved the generation: abandon. Otherwise withhold just those shards.
      if (event.kind === 'discarded' || event.kind === 'dropped') {
        const g = instancedShardGeneration();
        for (const id of event.modelIds) {
          if (event.full) tap.abandon(id, { generation: g - 1, epoch: Infinity });
          else tap.withhold(id, (event.withheld ?? []).filter((shard) => shard.modelId === id).map((shard) => shard.bytes));
        }
        return;
      }
      if (event.kind !== 'enqueued' || !event.shards) return;
      for (const modelId of event.modelIds) tap.shardEvents.set(modelId, (tap.shardEvents.get(modelId) ?? 0) + 1);
      for (const shard of event.shards) tap.ingestShard(shard.modelId, shard.bytes);
    }));
    tap.sync(store.getState());
    // Only a complete, current generation answers; anything else is unavailable.
    setReleasedGeometryMetadata({
      bounds: (modelId, id) => {
        const backing = tap.completeBacking(modelId);
        return backing?.directory.summary(id)?.bounds;
      },
      area: (modelId, id) => (tap.completeBacking(modelId) ? tap.tracked.get(modelId)?.areas.get(id) : undefined),
    });
    return tap;
  }

  get registryHandle(): GeometryBackingRegistry { return this.registry; }

  private completeBacking(modelId: string): ModelGeometryBacking | undefined {
    const tracked = this.tracked.get(modelId);
    const backing = tracked?.backing;
    return backing && !tracked.failure && !tracked.stale && backing.isCurrent && backing.isComplete ? backing : undefined;
  }

  /** The model's current backing generation, for readback consumers. */
  backing(modelId: string): ModelGeometryBacking | undefined {
    const tracked = this.tracked.get(modelId);
    return tracked && !tracked.stale ? tracked.backing : undefined;
  }

  /** The last acknowledged generation and its store members: what released meshes are replayed from. */
  replaySource(modelId: string): PreviousGeneration | undefined {
    const ack = this.acknowledged.get(modelId); return ack && { meshes: ack.members, backing: ack.backing };
  }

  private sync(state: TapState): void {
    if (this.stopped) return;
    const versionChanged = state.geometryContentVersion !== this.contentVersion;
    this.contentVersion = state.geometryContentVersion;
    for (const [modelId, model] of state.models) {
      const meshes = model.geometryResult?.meshes;
      const tracked = this.tracked.get(modelId);
      if (!tracked) { this.regenerate(modelId, meshes, 'none'); continue; }
      // First geometry of a model whose shards arrived earlier: an append.
      if (!versionChanged && tracked.meshes === undefined && tracked.consumed === 0 && meshes) tracked.meshes = meshes;
      if (tracked.stale) continue;
      if (versionChanged || meshes !== tracked.meshes || (meshes && meshes.length < tracked.consumed)) {
        // Released members are replayed from the acknowledged generation, which stays
        // durable until the replacement commits (`regenerate`).
        const hadShards = tracked.occurrences > 0 || tracked.instancedLost;
        this.regenerate(modelId, meshes, !hadShards ? 'none' : versionChanged ? 'lost' : 'carry');
        continue;
      }
      if (meshes && meshes.length > tracked.consumed) {
        if (meshes.slice(tracked.consumed).some(isReleasedMesh)) {
          tracked.stale = new Error('Released meshes were appended; they have no arrays to back');
          console.error(`[GeometryBacking] ${modelId}: ${tracked.stale.message}`);
          notifyReleasedGeometryMetadataChanged();
          continue;
        }
        if (this.acknowledged.get(modelId) === tracked) this.regenerate(modelId, meshes, 'carry'); // sealed: a successor
        else this.appendSuffix(tracked, meshes);
      }
    }
    for (const modelId of [...this.tracked.keys()]) {
      if (!state.models.has(modelId)) this.drop(modelId, 'Model was removed');
    }
  }

  private regenerate(modelId: string, meshes: MeshData[] | undefined, shards: 'none' | 'carry' | 'lost' | 'withhold', withheld?: ReadonlySet<ArrayBuffer>): void {
    const previous = this.tracked.get(modelId);
    const key = `${modelId}\u0001${++this.sequence}`;
    // Every older generation stays durable until this one is acknowledged complete (`seal`).
    const next: Tracked = { key, number: (previous?.number ?? 0) + 1, meshes, members: [], consumed: 0,
      // Lost instancing is sticky: no later edit may fall back to pre-loss (stale) occurrences.
      chain: Promise.resolve(), instancedLost: shards === 'lost' || shards === 'withhold' || (shards === 'carry' && !!previous?.instancedLost),
      lostAt: shards === 'lost' ? supplyPoint(modelId) : shards === 'withhold' ? { ...supplyPoint(modelId), epoch: instancedShardModelEpoch(modelId) - 1 } : previous?.lostAt,
      resupply: shards === 'carry' ? previous?.resupply : undefined, supplied: shards === 'carry' ? previous?.supplied : undefined, shards: 0, occurrences: 0, sources: [], areas: new Map(),
      retained: previous ? [...previous.retained, previous.key] : [] };
    const begun = (previous?.chain ?? Promise.resolve()).then(async () => {
      next.backing = await this.registry.begin(key, this.options);
      // A re-supplying predecessor holds only fresh shards: carry those, never the pre-loss ones.
      // `withhold` keeps every shard the scene drew (all but `withheld`), from the predecessor itself.
      if (shards === 'withhold' || (shards === 'carry' && (!next.instancedLost || next.resupply))) {
        // Resolved now, after the chain: a failed or unstarted predecessor falls back to the acknowledged one.
        const source = shards === 'withhold' || next.resupply || (previous?.backing && !previous.failure) ? previous : this.acknowledged.get(modelId);
        if (!source?.backing || source.failure || (source.instancedLost && !next.resupply && shards !== 'withhold')) next.instancedLost = true;
        else {
          let ordinal = -1, found = 0;
          for await (const shard of source.backing.reader.instancedShards()) {
            const from = source.sources[++ordinal] ?? null;
            if (from && withheld?.has(from)) { found++; continue; }
            next.shards++; next.occurrences += shard.instances.length; next.sources.push(source.sources[ordinal] ?? null);
            await next.backing.writer.appendInstancedShard(shard);
          }
          // A withheld shard the predecessor never backed: its membership is unknown, fail closed.
          if (withheld && found !== withheld.size) throw new Error('A withheld instanced shard was not among the backed ones');
        }
      }
    });
    next.chain = this.settle(next, begun);
    this.tracked.set(modelId, next);
    // A content bump keeps the list identity; the provider now answers from an incomplete generation.
    if (previous) notifyReleasedGeometryMetadataChanged();
    if (meshes && meshes.length > 0) {
      if (meshes.some(isReleasedMesh)) this.replay(modelId, next, meshes);
      else this.appendSuffix(next, meshes);
    }
  }

  /** Released members come from the acknowledged generation's records, chunk by chunk (no CPU restore). */
  private replay(modelId: string, next: Tracked, meshes: MeshData[]): void {
    const list = meshes.slice(); next.consumed = list.length; next.members = list;
    this.enqueue(next, async () => {
      // Captured when the step runs: overlapping edits all replay from the one acknowledged source,
      // and a released copy of a copy reaches its record through its ancestry.
      for await (const batch of replayStoreList(list, this.replaySource(modelId) ?? { meshes: undefined, backing: undefined }, APPEND_BATCH)) {
        for (const [id, entry] of collectMeshAreas([batch])) {
          const prior = next.areas.get(id);
          next.areas.set(id, prior ? { area: prior.area + entry.area, incomplete: prior.incomplete || entry.incomplete } : entry);
        }
        await this.writer(next).append(batch);
      }
    });
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
    tracked.members.push(...slice);
    // Areas while the arrays are resident; pieces of one entity across slices add up
    // exactly as one pass over the list would (`collectMeshAreas` groups by entity).
    for (const [id, entry] of collectMeshAreas([slice])) {
      const prior = tracked.areas.get(id);
      tracked.areas.set(id, prior ? { area: prior.area + entry.area, incomplete: prior.incomplete || entry.incomplete } : entry);
    }
    this.enqueue(tracked, async () => {
      for (let i = 0; i < slice.length; i += APPEND_BATCH) {
        await this.writer(tracked).append(slice.slice(i, i + APPEND_BATCH));
      }
    });
  }

  private ingestShard(modelId: string, bytes: ArrayBuffer): void {
    if (this.stopped) return;
    // A sealed generation's writer is closed: stage a successor that carries it, then append there.
    if (!this.tracked.has(modelId)) this.regenerate(modelId, undefined, 'none');
    else if (this.acknowledged.get(modelId) === this.tracked.get(modelId)) this.regenerate(modelId, this.tracked.get(modelId)!.meshes, 'carry');
    const target = this.tracked.get(modelId)!;
    if (!admitShard(target, supplyPoint(modelId))) return; // `instanced-resupply.ts`
    target.shards++;
    // Decode a private copy: the drain may transfer or reuse the queued bytes.
    const shard = decodeInstancedShard(bytes.slice(0));
    // The drain re-homes shard ids into the federated id space after decoding;
    // do the same, so backed occurrences answer the ids picks and flat meshes use.
    const idOffset = this.store.getState().models.get(modelId)?.idOffset;
    if (idOffset === undefined) {
      target.instancedLost = true;
      if (target.resupply) target.resupply.broken = true;
      console.error(`[GeometryBacking] shard for unregistered model ${modelId}; its instancing is not backed`);
      return;
    }
    applyFederationOffsetToShard(shard, idOffset);
    target.occurrences += shard.instances.length;
    if (target.resupply) target.resupply.received++;
    // Recorded in backed order (after any carried shards), for `withhold`.
    this.enqueue(target, async () => { await this.writer(target).appendInstancedShard(shard); target.sources.push(bytes); });
  }

  /** Lost instancing is whole again only by the model's own statement, matched shard for shard. */
  private onSupply(supply: InstancedShardSupply): void {
    const tracked = this.stopped ? undefined : this.tracked.get(supply.modelId);
    if (tracked) acceptStatement(tracked, supply);
  }

  /** Shards dropped before upload: keep exactly what the scene drew, lost until the rest is stated. */
  private withhold(modelId: string, bytes: readonly ArrayBuffer[]): void {
    const tracked = this.stopped ? undefined : this.tracked.get(modelId); // resolved against backed order once the chain settles
    if (tracked && this.store.getState().models.has(modelId)) this.regenerate(modelId, tracked.meshes, 'withhold', new Set(bytes));
  }

  /** Instancing whose shards were dropped before upload: a fresh lost generation, never carrying the abandoned shards. */
  private abandon(modelId: string, lostAt: SupplyPoint): void {
    const tracked = this.stopped ? undefined : this.tracked.get(modelId);
    if (!tracked || !this.store.getState().models.has(modelId)) return;
    this.regenerate(modelId, tracked.meshes, 'lost');
    this.tracked.get(modelId)!.lostAt = lostAt;
  }

  private enqueue(tracked: Tracked, step: () => Promise<void>): void {
    tracked.chain = this.settle(tracked, tracked.chain.then(() => (tracked.failure ? undefined : step())));
  }

  /** Record the first failure per generation; later steps are skipped, not retried. */
  private settle(tracked: Tracked, step: Promise<void>): Promise<void> {
    return step.then(undefined, (error: unknown) => {
      if (tracked.failure) return;
      tracked.failure = error instanceof Error ? error : new Error(String(error));
      console.error('[GeometryBacking] model backing failed; CPU geometry must stay resident', tracked.failure);
      notifyReleasedGeometryMetadataChanged(); // its bounds and areas stop answering in place
    });
  }

  private drop(modelId: string, reason: string): void {
    const tracked = this.tracked.get(modelId); if (!tracked) return;
    this.tracked.delete(modelId);
    this.acknowledged.delete(modelId);
    notifyReleasedGeometryMetadataChanged();
    this.settle(tracked, tracked.chain.then(async () => {
      for (const key of [...tracked.retained, tracked.key]) await this.registry.invalidate(key, reason);
    }));
  }

  /** Resolve once every queued append has been handed to its writer. */
  async whenIdle(): Promise<void> {
    // Steps may enqueue more steps or regenerate; settle until nothing moved.
    for (;;) {
      const chains = [...this.tracked.values()].map((tracked) => tracked.chain);
      await Promise.all(chains);
      const now = [...this.tracked.values()].map((tracked) => tracked.chain);
      if (now.length === chains.length && now.every((chain, i) => chain === chains[i])) return;
    }
  }

  /** Close every model's writer and acknowledge complete generations. */
  async seal(): Promise<ModelBackingStatus[]> {
    // A statement holds only while its queue generation does: a full discard since (even of nothing) voids it.
    for (const [modelId, tracked] of this.tracked) if (statementVoided(tracked, supplyPoint(modelId))) this.abandon(modelId, { generation: tracked.supplied!.generation, epoch: tracked.supplied!.epoch });
    await this.whenIdle();
    let acknowledged = false;
    for (const [modelId, tracked] of this.tracked) {
      if (tracked.failure || tracked.instancedLost || tracked.stale || this.missedShards(modelId) || !tracked.backing) continue;
      const backing = tracked.backing;
      await this.settle(tracked, backing.acknowledge().then(async (ack) => {
        // Only a verified, complete, still-current replacement may retire what it replaces.
        if (!this.registry.verify(ack) || this.tracked.get(modelId) !== tracked || tracked.failure) return;
        acknowledged ||= this.acknowledged.get(modelId) !== tracked;
        tracked.supplied = undefined;
        this.acknowledged.set(modelId, tracked);
        for (const old of tracked.retained.splice(0)) await this.registry.invalidate(old, 'Replaced by an acknowledged generation');
      }));
    }
    if (acknowledged) notifyReleasedGeometryMetadataChanged(); // complete generations answer in place
    return this.status();
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
        modelId, generation: tracked.number, meshes: tracked.consumed,
        chunks: backing?.directory.chunks.length ?? 0, shards: backing?.directory.shards.length ?? 0,
        storedBytes: backing?.directory.storedBytes ?? 0, pendingBytes: backing?.writer.pendingBytes ?? 0,
        complete: !!backing?.isComplete && !instancedLost && !tracked.failure && !tracked.stale,
        instancedLost, ...(error ? { error: `${error.name}: ${error.message}` } : {}),
      };
    });
  }

  /** Stop observing and delete this page's backing. */
  async stop(): Promise<void> {
    this.stopped = true;
    setReleasedGeometryMetadata(null);
    for (const stop of this.stops.splice(0)) stop();
    await Promise.all([...this.tracked.values()].map((tracked) => tracked.chain));
    this.tracked.clear();
    this.acknowledged.clear();
    await this.registry.close();
  }
}
