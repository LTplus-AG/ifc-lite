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
import { type InstancedShardSupply, type PendingInstancedShard, hasPendingInstancedShards, instancedShardGeneration, instancedShardModelEpoch, subscribeInstancedShards, subscribeInstancedShardSupply } from '@/store/instancedShardQueue';
import { PreTapSupply } from './pre-tap-supply';
import { isReleasedMesh } from '@/lib/released-mesh-provenance';
import { applyFederationOffsetToShard } from '@/components/viewer/instancedFederationOffset';
import { collectMeshAreas, type MeshAreaEntry } from '@/components/viewer/tools/measure-modes/mesh-area';
import { acceptStatement, admitShard, type ResupplyState, statementVoided, supplyPoint, type SupplyPoint } from './instanced-resupply';
import { notifyReleasedGeometryMetadataChanged, setReleasedGeometryMetadata } from './released-geometry-metadata';
import { type PreviousGeneration, replayStoreList } from './generation-replay';
import { carryBackedShards } from './carry-shards';
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
  sources: (PendingInstancedShard | null)[]; // the queue entry each backed shard came from, in backed order
  /** Instanced occurrences backed; empty shard records are not instancing. */
  occurrences: number;
  /** The store list changed after a CPU release: this generation is kept durable but no longer answers. */
  stale?: Error;
  /** Per-entity mesh area of this generation, summed as `collectMeshAreas` sums the whole list. */
  areas: Map<number, MeshAreaEntry>;
  flatSealed?: boolean; // instancing lost, every flat record flushed by a seal and nothing written since (`flatComplete`)
  /** Replaced (or removed) before its generation began: superseded as soon as it does (#10876). */
  replaced?: boolean;
  /** A carry of the predecessor's shards is still pending: they count as this generation's shards (#10876). */
  carrying?: boolean;
  /** The store has listed this model: only then can its absence mean a removal (a shard may arrive first, #10876). */
  registered?: boolean;
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
  private readonly shardEvents = new Map<string, number>(); private readonly preTap = new PreTapSupply(); // `pre-tap-supply.ts`
  private sequence = 0;
  /** Per model, the last generation acknowledged complete: the only replay source. */
  private readonly acknowledged = new Map<string, Tracked>();
  private stopped = false;
  private readonly unbacked = new WeakSet<PendingInstancedShard>(); // ingested, never backed: not membership
  /** Deferred cleanups of removed models' generations, awaited by `whenIdle` (#10876). */
  private readonly removals = new Set<Promise<void>>();

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
          else tap.withhold(id, (event.withheld ?? []).filter((shard) => shard.modelId === id));
        }
        return;
      }
      if ((event.kind !== 'enqueued' && event.kind !== 'adopted') || !event.shards) return;
      for (const modelId of event.modelIds) tap.shardEvents.set(modelId, (tap.shardEvents.get(modelId) ?? 0) + 1);
      for (const shard of event.shards) tap.ingestShard(shard);
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
      if (tracked) tracked.registered = true;
      if (!tracked) {
        // A list already released when the tap first sees it (a restart after release-for-test) has no arrays
        // to back and no acknowledged generation to replay from: never back its empty records (#10876).
        if (meshes?.some(isReleasedMesh)) {
          const stale = this.blank(modelId, meshes);
          stale.stale = new Error('The store list was released before the tap saw it; nothing can be backed');
          stale.consumed = meshes.length;
          this.tracked.set(modelId, stale);
          console.error(`[GeometryBacking] ${modelId}: ${stale.stale.message}`);
        } else this.regenerate(modelId, meshes, 'none');
        this.tracked.get(modelId)!.registered = true;
        continue;
      }
      // A content change loses committed instancing until re-supply is proved, on EVERY path, including the
      // stale exit below that builds no successor now: a later carry must not revive it (#10876).
      if (versionChanged && (tracked.occurrences > 0 || tracked.carrying) && !tracked.instancedLost) {
        tracked.instancedLost = true; tracked.lostAt = supplyPoint(modelId);
      }
      // First geometry of a model whose shards arrived earlier: an append.
      if (!versionChanged && tracked.meshes === undefined && tracked.consumed === 0 && meshes) tracked.meshes = meshes;
      // A stale generation answers nothing; only a fresh resident list may replace it (#10876).
      if (tracked.stale && !(meshes && meshes !== tracked.meshes && meshes.length > 0 && !meshes.some(isReleasedMesh))) continue;
      if (versionChanged || meshes !== tracked.meshes || (meshes && meshes.length < tracked.consumed)) {
        // Released members are replayed from the acknowledged generation, which stays
        // durable until the replacement commits (`regenerate`).
        const hadShards = tracked.occurrences > 0 || tracked.instancedLost || !!tracked.carrying;
        this.regenerate(modelId, meshes, !hadShards ? 'none' : versionChanged ? 'lost' : 'carry');
        continue;
      }
      if (meshes && meshes.length > tracked.consumed) {
        if (meshes.slice(tracked.consumed).some(isReleasedMesh)) {
          tracked.stale = new Error('Released meshes were appended; they have no arrays to back');
          this.supersede(tracked);
          console.error(`[GeometryBacking] ${modelId}: ${tracked.stale.message}`);
          notifyReleasedGeometryMetadataChanged();
          continue;
        }
        if (this.acknowledged.get(modelId) === tracked) this.regenerate(modelId, meshes, 'carry'); // sealed: a successor
        else this.appendSuffix(tracked, meshes);
      }
    }
    for (const [modelId, tracked] of [...this.tracked]) {
      // Only a model the store has listed can be removed: a shard may arrive before its model registers.
      if (tracked.registered && !state.models.has(modelId)) this.drop(modelId, 'Model was removed');
    }
  }

  /** A generation record with nothing in it yet. */
  private blank(modelId: string, meshes: MeshData[] | undefined, previous?: Tracked): Tracked {
    return { key: `${modelId}\u0001${++this.sequence}`, number: (previous?.number ?? 0) + 1, meshes, members: [], consumed: 0,
      chain: Promise.resolve(), instancedLost: false, shards: 0, occurrences: 0, sources: [], areas: new Map(),
      retained: previous ? [...previous.retained, previous.key] : [], registered: previous?.registered };
  }

  /** The store replaced this generation's geometry: not current for consumers from now on, even before its
   * successor begins (#10876). Its records stay durable for the tap's own replay and carry until retired. */
  private supersede(tracked: Tracked | undefined): void {
    if (!tracked) return;
    if (tracked.backing) tracked.backing.supersede(); else tracked.replaced = true;
  }

  private regenerate(modelId: string, meshes: MeshData[] | undefined, shards: 'none' | 'carry' | 'lost' | 'withhold', withheld?: ReadonlySet<PendingInstancedShard>): void {
    const previous = this.tracked.get(modelId);
    // A retained handle (the acknowledged one included) must never answer the geometry the store just replaced.
    this.supersede(previous);
    if (this.acknowledged.get(modelId) !== previous) this.supersede(this.acknowledged.get(modelId));
    const key = `${modelId}\u0001${++this.sequence}`;
    // Every older generation stays durable until this one is acknowledged complete (`seal`).
    const next: Tracked = { key, number: (previous?.number ?? 0) + 1, meshes, members: [], consumed: 0,
      // Lost instancing is sticky: no later edit may fall back to pre-loss (stale) occurrences.
      chain: Promise.resolve(), instancedLost: shards === 'lost' || shards === 'withhold' || (shards === 'carry' && !!previous?.instancedLost),
      lostAt: shards === 'lost' ? supplyPoint(modelId) : shards === 'withhold' ? { ...supplyPoint(modelId), epoch: instancedShardModelEpoch(modelId) - 1 } : previous?.lostAt,
      resupply: shards === 'carry' ? previous?.resupply : undefined, supplied: shards === 'carry' ? previous?.supplied : undefined, shards: 0, occurrences: 0, sources: [], areas: new Map(),
      retained: previous ? [...previous.retained, previous.key] : [], registered: previous?.registered,
      carrying: shards === 'carry' || shards === 'withhold' };
    const preTap = this.preTap.lost(modelId); if (preTap && !next.instancedLost) { next.instancedLost = true; next.lostAt = preTap; } // drawn before the tap
    const begun = (previous?.chain ?? Promise.resolve()).then(async () => {
      next.backing = await this.registry.begin(key, this.options);
      if (next.replaced) next.backing.supersede(); // replaced again before it began
      // A re-supplying predecessor holds only fresh shards (never pre-loss ones); `withhold` keeps all the scene drew.
      if (shards === 'withhold' || (shards === 'carry' && (!next.instancedLost || next.resupply))) {
        // Resolved now, after the chain: a failed or unstarted predecessor falls back to the acknowledged one.
        const source = shards === 'withhold' || next.resupply || (previous?.backing && !previous.failure) ? previous : this.acknowledged.get(modelId);
        if (!source?.backing || source.failure || (source.instancedLost && !next.resupply && shards !== 'withhold')) next.instancedLost = true;
        else await carryBackedShards(source, next, withheld); // `carry-shards.ts`
      }
      next.carrying = false;
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

  private ingestShard(entry: PendingInstancedShard, { modelId, bytes } = entry): void {
    if (this.stopped) return;
    // A sealed generation's writer is closed: stage a successor that carries it, then append there.
    if (!this.tracked.has(modelId)) this.regenerate(modelId, undefined, 'none');
    else if (this.acknowledged.get(modelId) === this.tracked.get(modelId)) this.regenerate(modelId, this.tracked.get(modelId)!.meshes, 'carry');
    const target = this.tracked.get(modelId)!;
    // A stale generation answers nothing and takes nothing more (released arrays are terminal, #10876).
    if (target.stale) { this.unbacked.add(entry); return; }
    if (!admitShard(target, supplyPoint(modelId))) { this.unbacked.add(entry); return; } // `instanced-resupply.ts`
    target.shards++;
    // Decode a private copy: the drain may transfer or reuse the queued bytes. A shard that does not decode is a
    // failure of this generation (never acknowledged), not an exception that skips it unrecorded (#10876).
    let shard: DecodedInstancedShard;
    try { shard = decodeInstancedShard(bytes.slice(0)); } catch (error) {
      this.unbacked.add(entry);
      void this.settle(target, Promise.reject(error));
      return;
    }
    target.occurrences += shard.instances.length;
    if (target.resupply) target.resupply.received++;
    this.enqueue(target, async () => {
      // Re-home ids into the federated id space, as the drain does: backed occurrences answer the ids picks use.
      // Read when the append runs: a shard may arrive before its model registers (the drain waits for it too).
      // Still unregistered by then: its instancing is not backed (fail closed). No offset: model 0's space.
      const model = this.store.getState().models.get(modelId);
      if (!model) {
        this.unbacked.add(entry); target.instancedLost = true; if (target.resupply) target.resupply.broken = true;
        console.error(`[GeometryBacking] shard for unregistered model ${modelId}; its instancing is not backed`); return;
      }
      applyFederationOffsetToShard(shard, model.idOffset ?? 0);
      // Recorded in backed order (after any carried shards), for `withhold`.
      await this.writer(target).appendInstancedShard(shard); target.sources.push(entry);
    });
  }

  /** Lost instancing is whole again only by the model's own statement, matched shard for shard. */
  private onSupply(supply: InstancedShardSupply): void {
    const tracked = this.stopped ? undefined : this.tracked.get(supply.modelId);
    if (tracked) { acceptStatement(tracked, supply); if (!tracked.instancedLost) this.preTap.resupplied(supply.modelId); }
  }

  /** Shards dropped before upload: keep exactly what the scene drew, lost until the rest is stated. */
  private withhold(modelId: string, entries: readonly PendingInstancedShard[]): void {
    const tracked = this.stopped ? undefined : this.tracked.get(modelId); // resolved against backed order once the chain settles
    // A never-backed entry was never membership: withholding it changes nothing it held.
    if (tracked && this.store.getState().models.has(modelId)) this.regenerate(modelId, tracked.meshes, 'withhold', new Set(entries.filter((e) => !this.unbacked.has(e))));
  }

  /** Instancing whose shards were dropped before upload: a fresh lost generation, never carrying the abandoned shards. */
  private abandon(modelId: string, lostAt: SupplyPoint): void {
    const tracked = this.stopped ? undefined : this.tracked.get(modelId);
    if (!tracked || !this.store.getState().models.has(modelId)) return;
    this.regenerate(modelId, tracked.meshes, 'lost');
    this.tracked.get(modelId)!.lostAt = lostAt;
  }

  private enqueue(tracked: Tracked, step: () => Promise<void>): void {
    tracked.flatSealed = false; // a write after the seal: its flat records are no longer proven whole
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
    const acknowledged = this.acknowledged.get(modelId);
    this.acknowledged.delete(modelId);
    this.supersede(tracked); // a retained handle stops being current now, not once the pending append ends
    if (acknowledged !== tracked) this.supersede(acknowledged);
    notifyReleasedGeometryMetadataChanged();
    // Retire exactly this model's generations; `whenIdle` (and so `stop`) waits for them (#10876).
    const removal = this.settle(tracked, tracked.chain.then(async () => {
      for (const key of [...tracked.retained, tracked.key]) await this.registry.invalidate(key, reason);
    }));
    this.removals.add(removal);
    void removal.then(() => { this.removals.delete(removal); });
  }

  /** Resolve once every queued append has been handed to its writer. */
  async whenIdle(): Promise<void> { // steps may enqueue more steps or regenerate: settle until nothing moved
    for (const chains = () => [...[...this.tracked.values()].map((tracked) => tracked.chain), ...this.removals]; ;) {
      const before = chains(); await Promise.all(before);
      const now = chains(); if (now.length === before.length && now.every((chain, i) => chain === before[i])) return;
    }
  }

  /** Close every model's writer and acknowledge complete generations. */
  async seal(): Promise<ModelBackingStatus[]> {
    // A statement holds only while its queue generation does: a full discard since (even of nothing, so with
    // no event) voids it. Checked again after every await, so one during the seal is never acknowledged.
    const voided = (modelId: string, tracked: Tracked) => {
      if (statementVoided(tracked, supplyPoint(modelId))) { this.abandon(modelId, { ...tracked.supplied! }); return true; } return false;
    };
    for (const [modelId, tracked] of this.tracked) voided(modelId, tracked);
    await this.whenIdle();
    let acknowledged = false;
    for (const [modelId, tracked] of [...this.tracked]) {
      // No geometry yet (`geometryResult: null` before the first batch) is not an empty model: never acknowledged.
      if (voided(modelId, tracked) || tracked.failure || tracked.stale || !tracked.backing || tracked.meshes === undefined) continue;
      if (tracked.instancedLost) { // never acknowledged; its flat records alone answer flat-only readers once flushed
        const flushed = tracked.backing.writer.flush().then(() => { tracked.flatSealed = this.tracked.get(modelId) === tracked && !tracked.failure; });
        await this.settle(tracked, flushed); acknowledged ||= !!tracked.flatSealed; continue;
      }
      if (this.missedShards(modelId) || hasPendingInstancedShards(modelId)) continue; // undrawn shards: not what the scene shows yet
      const backing = tracked.backing;
      await this.settle(tracked, backing.acknowledge().then(async (ack) => {
        // Only a verified, complete, still-current replacement whose statement still holds may retire what it replaces.
        if (!this.registry.verify(ack) || this.tracked.get(modelId) !== tracked || tracked.failure || voided(modelId, tracked) || hasPendingInstancedShards(modelId)) return;
        acknowledged ||= this.acknowledged.get(modelId) !== tracked;
        tracked.supplied = undefined;
        this.acknowledged.set(modelId, tracked);
        for (const old of tracked.retained.splice(0)) await this.registry.invalidate(old, 'Replaced by an acknowledged generation');
      }));
    }
    if (acknowledged) notifyReleasedGeometryMetadataChanged(); // complete generations answer in place
    return this.status();
  }

  /**
   * The release allowlist (#10876): the model's current generation and the exact list it verified, only when
   * it is registered, acknowledged (sealed) and current, idle-complete (every listed mesh consumed, no shard
   * pending, carried or missed), not stale or failed, and backs resident arrays. Anything else: undefined.
   */
  releaseCandidate(modelId: string): { backing: ModelGeometryBacking; meshes: MeshData[] } | undefined {
    const tracked = this.tracked.get(modelId);
    const backing = tracked?.backing, meshes = tracked?.meshes;
    if (!tracked || !backing || !meshes || !tracked.registered || this.acknowledged.get(modelId) !== tracked || tracked.stale
      || tracked.failure || tracked.instancedLost || tracked.carrying || tracked.replaced || this.missedShards(modelId)
      || hasPendingInstancedShards(modelId)) return undefined;
    if (!backing.isCurrent || !backing.isComplete || tracked.consumed !== meshes.length || meshes.some(isReleasedMesh)) return undefined;
    return { backing, meshes };
  }

  /** Shards were enqueued for this model that the tap never saw. */
  /** The current generation lost only its instancing and every flat record is sealed and durable (`BackingSource.flatComplete`). */
  flatComplete(modelId: string): boolean {
    const t = this.tracked.get(modelId), b = t?.backing;
    return !!t?.flatSealed && !!b && !t.failure && !t.stale && b.isCurrent && !b.writer.error && !b.writer.hasUnsealed && b.writer.pendingBytes === 0 && b.directory.chunks.every((c) => c.state === 'durable');
  }
  private missedShards(modelId: string): boolean { return this.preTap.missed(modelId, this.shardEvents.get(modelId) ?? 0); }

  status(): ModelBackingStatus[] {
    return [...this.tracked].map(([modelId, tracked]) => {
      const backing = tracked.backing;
      const instancedLost = tracked.instancedLost || this.missedShards(modelId);
      const error = tracked.stale ?? tracked.failure ?? backing?.writer.error;
      return {
        modelId, generation: tracked.number, meshes: tracked.consumed,
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
    setReleasedGeometryMetadata(null);
    for (const stop of this.stops.splice(0)) stop();
    // Every owned chain AND every pending removal (their deletes included) before the registry and its database
    // close: a deferred delete after close would leave orphan records (#10876). Failures are settled.
    await this.whenIdle();
    this.tracked.clear(); this.acknowledged.clear();
    await this.registry.close();
  }
}
