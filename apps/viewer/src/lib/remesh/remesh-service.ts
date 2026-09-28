/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `requestRemesh`: rebuild the rendered meshes of edited elements with the
 * same wasm mesher the load used (#6232 WP1). The seam every authoring
 * commit calls — today `resizeWall` and undo/redo through
 * `remesh-registry.ts`; the authoring transaction (WP2) next.
 *
 *   1. expand the edited ids to what the edit moves (`affected-set.ts`);
 *   2. serialize just those elements and their context to a mini STEP file
 *      (`serializeEntitySubgraph`, O(affected), edits applied);
 *   3. mesh it in the long-lived re-mesh worker, in the model's load RTC
 *      frame, with the model's style wire (captured once per model);
 *   4. take the meshes to the render frame (`render-frame.ts`);
 *   5. swap them in with one `replaceEntityMeshes` update, which
 *      `useMeshEditDrain` hands to the renderer.
 *
 * A request superseded by a later one for any of the same elements, for a
 * model that was unloaded or reloaded, or for an element deleted meanwhile
 * is dropped ('stale'). A request that cannot be honoured says why in a
 * notice, once per model and reason; the edit itself is always kept.
 */

import type { StoreApi } from 'zustand';
import type { IfcDataStore } from '@ifc-lite/parser';
import { serializeEntitySubgraph } from '@ifc-lite/export';
import { hostsOtherEntities } from '@ifc-lite/renderer';
import type { MeshData } from '@ifc-lite/geometry';
import { RemeshClient, filterStyleWire, type RemeshConfig, type RemeshRequest, type RemeshResult, type StyleWire } from '@ifc-lite/geometry/remesh';
import type { ViewerState } from '@/store';
import type { FederatedModel } from '@/store/types';
import { isIfcxDataStore } from '@/store/types';
import { toGlobalIdFromModels } from '@/store/globalId';
import type { PreAlignmentMeshBaseline } from '@/store/slices/data-mesh-prealign';
import { toast } from '@/components/ui/toast';
import { resolve } from '@/i18n/registry';
import type { TranslationKey } from '@/i18n';
import { expandAffectedSet, type RemeshCause } from './affected-set';
import { loadRtcFrame, toRenderFrame } from './render-frame';

export type { RemeshCause } from './affected-set';
type Get = () => ViewerState;

export type RemeshRefusal = 'noSource' | 'noFrame' | 'colourMerged' | 'unreadable' | 'alignment';
export interface RemeshTimings { walk: number; styles: number; worker: number; prepass: number; produce: number; frame: number; total: number }
export type RemeshOutcome =
  | { status: 'applied'; globalIds: number[]; csgFailures: number; ms: RemeshTimings }
  | { status: 'stale' }
  | { status: 'refused'; reason: RemeshRefusal }
  | { status: 'failed'; message: string };

/** What the service needs of a `RemeshClient`; tests pass a scripted one. */
export interface RemeshClientLike {
  readonly alive: boolean;
  remesh(request: RemeshRequest): Promise<RemeshResult>;
  styleWire(source: Uint8Array): Promise<StyleWire>;
  setConfig(config: RemeshConfig): void;
  dispose(): void;
}
type ClientFactory = (config: RemeshConfig) => Promise<RemeshClientLike>;

const defaultFactory: ClientFactory = (config) => RemeshClient.create(config);
let factory: ClientFactory = defaultFactory;
let client: Promise<RemeshClientLike> | null = null;
/** The started client, for the synchronous fast path below. */
let readyClient: RemeshClientLike | null = null;
let clientConfig = '';
const styleWires = new WeakMap<IfcDataStore, Promise<StyleWire>>();
const readyWires = new WeakMap<IfcDataStore, StyleWire>();
const generations = new Map<string, number>();
const noticed = new Set<string>();
/** Bumped by every deliberate dispose, so a request it cut off reads as stale, not failed. */
let disposals = 0;

/** Swap the worker factory (tests; `null` restores the real worker). Disposes the current client. */
export function setRemeshClientFactory(next: ClientFactory | null): void {
  disposeRemeshClient();
  factory = next ?? defaultFactory;
}

/** Terminate the re-mesh worker; the next request starts a new one. */
export function disposeRemeshClient(): void {
  const current = client;
  if (current) disposals += 1;
  client = null;
  readyClient = null;
  clientConfig = '';
  void current?.then((c) => c.dispose(), () => undefined);
}

/**
 * Terminate the worker whenever a model is unloaded or reloaded. The worker
 * keeps whatever its wasm heap grew to (a style-wire pre-pass parses the whole
 * file, and wasm memory never shrinks), so an idle worker would otherwise pin
 * a closed model's footprint for the rest of the session. The next edit starts
 * a fresh one; style wires stay cached on the main thread, per data store.
 * Returns the unsubscribe.
 */
export function watchModelUnloads(subscribe: StoreApi<ViewerState>['subscribe']): () => void {
  return subscribe((state, previous) => {
    if (state.models === previous.models) return;
    for (const [id, model] of previous.models) {
      if (model.ifcDataStore && state.models.get(id)?.ifcDataStore !== model.ifcDataStore) {
        disposeRemeshClient();
        return;
      }
    }
  });
}

/**
 * The worker for `config`. Synchronous once it has started, so a commit's
 * request is posted before the commit's own re-render runs and the worker
 * meshes while the main thread renders.
 */
function clientFor(config: RemeshConfig): RemeshClientLike | Promise<RemeshClientLike> {
  if (readyClient?.alive) {
    const key = JSON.stringify(config);
    if (key !== clientConfig) {
      readyClient.setConfig(config);
      clientConfig = key;
    }
    return readyClient;
  }
  return startClient(config);
}

async function startClient(config: RemeshConfig): Promise<RemeshClientLike> {
  let current = client ? await client.catch(() => null) : null;
  if (!current?.alive) {
    const started = factory(config);
    client = started;
    clientConfig = JSON.stringify(config);
    try {
      current = await started;
    } catch (error) {
      if (client === started) client = null;
      throw error;
    }
  }
  const key = JSON.stringify(config);
  if (key !== clientConfig) {
    current.setConfig(config);
    clientConfig = key;
  }
  readyClient = current;
  return current;
}

/** The load toggles that change mesh output, as this model was loaded. */
function configFor(state: ViewerState, model: FederatedModel): RemeshConfig {
  return {
    mergeLayers: state.mergeLayers,
    tessellationQuality: model.tessellationTier ?? null,
    skipSmallCuts: model.skipSmallCuts ?? false,
    rectParamFastPath: true,
  };
}

/** The model's style wire, captured once per load; synchronous once captured. */
function styleWireFor(worker: RemeshClientLike, store: IfcDataStore): StyleWire | Promise<StyleWire> {
  const ready = readyWires.get(store);
  if (ready) return ready;
  let wire = styleWires.get(store);
  if (!wire) {
    wire = store.source.withMaterializedAsync((bytes) => worker.styleWire(bytes));
    styleWires.set(store, wire);
    wire.then((captured) => readyWires.set(store, captured), () => styleWires.delete(store));
  }
  return wire;
}


function notice(modelId: string, key: TranslationKey, params?: Record<string, string>): void {
  const id = `${modelId}:${key}`;
  if (noticed.has(id)) return;
  noticed.add(id);
  toast.error(resolve(key, params));
}

const REFUSAL_NOTICES: Record<RemeshRefusal, TranslationKey> = {
  noSource: 'remesh.refused.noSource',
  noFrame: 'remesh.refused.noFrame',
  colourMerged: 'remesh.refused.colourMerged',
  unreadable: 'remesh.refused.unreadable',
  alignment: 'remesh.refused.alignment',
};

function refuse(modelId: string, reason: RemeshRefusal): RemeshOutcome {
  notice(modelId, REFUSAL_NOTICES[reason]);
  return { status: 'refused', reason };
}

/** True when a live mesh of these entities also hosts other entities' geometry. */
function hostsColourMerged(model: FederatedModel, globalIds: ReadonlySet<number>): boolean {
  return model.geometryResult?.meshes.some((mesh) => globalIds.has(mesh.expressId) && hostsOtherEntities(mesh)) ?? false;
}

function stamp(modelId: string, ids: Iterable<number>): Map<string, number> {
  const stamps = new Map<string, number>();
  for (const id of ids) {
    const key = `${modelId}:${id}`;
    const next = (generations.get(key) ?? 0) + 1;
    generations.set(key, next);
    stamps.set(key, next);
  }
  return stamps;
}

/** Still the newest request for every element, on the same load, none deleted. */
function isCurrent(get: Get, modelId: string, store: IfcDataStore, stamps: Map<string, number>, ids: Iterable<number>): boolean {
  const state = get();
  if (state.models.get(modelId)?.ifcDataStore !== store) return false;
  for (const [key, value] of stamps) if (generations.get(key) !== value) return false;
  const tombstones = state.mutationViews.get(modelId)?.getTombstones();
  for (const id of ids) if (tombstones?.has(id)) return false;
  return true;
}

/**
 * `values` grouped by their mesh's entity, for the requested entities only.
 * An entity the mesher produced nothing for is left out, so it keeps the mesh
 * it has: an edit that leaves an element unmeshable (an unset extrusion depth)
 * must not make it vanish.
 */
function groupByGlobalId<T>(globalIds: ReadonlySet<number>, meshes: readonly MeshData[], values: readonly T[]): Map<number, T[]> {
  const out = new Map<number, T[]>();
  meshes.forEach((mesh, i) => {
    if (!globalIds.has(mesh.expressId)) return;
    const list = out.get(mesh.expressId);
    if (list) list.push(values[i]);
    else out.set(mesh.expressId, [values[i]]);
  });
  return out;
}

/**
 * Re-mesh `expressIds` (model-local) of `modelId` after an edit. Never
 * throws; the outcome says what happened.
 */
export interface RemeshOptions {
  /**
   * Also send each re-meshed element's meshes to the collaboration room, so
   * peers see the real geometry. A commit asks for this; an undo / redo
   * replay does not (positional undo stays local, and so does its mesh).
   */
  mirror?: boolean;
}

/** Requests still in flight per loaded model, by what they ask for and the edit state they asked it of. */
const inFlight = new WeakMap<object, Map<string, Promise<RemeshOutcome>>>();

/**
 * One commit can ask twice for the same thing (an add re-meshes the element it
 * creates, and a modeling transaction re-meshes what its commit reports), so
 * an identical request made before any further edit shares the pending one.
 */
export function requestRemesh(
  get: Get, modelId: string, expressIds: Iterable<number>, cause: RemeshCause, options: RemeshOptions = {},
): Promise<RemeshOutcome> {
  const ids = [...expressIds].sort((a, b) => a - b);
  const store = get().models.get(modelId)?.ifcDataStore;
  if (!store) return remesh(get, modelId, ids, cause, options);
  let pending = inFlight.get(store);
  if (!pending) inFlight.set(store, pending = new Map());
  const key = `${cause}|${options.mirror ? 1 : 0}|${get().mutationVersion}|${ids.join(',')}`;
  const shared = pending.get(key);
  if (shared) return shared;
  const request = remesh(get, modelId, ids, cause, options);
  pending.set(key, request);
  const forget = () => { if (pending!.get(key) === request) pending!.delete(key); };
  void request.then(forget, forget);
  return request;
}

async function remesh(
  get: Get, modelId: string, expressIds: Iterable<number>, cause: RemeshCause, options: RemeshOptions,
): Promise<RemeshOutcome> {
  const start = performance.now();
  const state = get();
  const model = state.models.get(modelId);
  const store = model?.ifcDataStore;
  if (!model || !store) return { status: 'stale' };
  if (!store.source || store.source.byteLength === 0 || isIfcxDataStore(store)) return refuse(modelId, 'noSource');
  const frame = loadRtcFrame(model);
  if (!frame) return refuse(modelId, 'noFrame');
  const view = state.mutationViews.get(modelId) ?? null;
  const targets = expandAffectedSet(store, view, expressIds, cause);
  if (targets.size === 0) return { status: 'stale' };
  const globalIds = new Set([...targets].map((id) => toGlobalIdFromModels(state.models, modelId, id)));
  if (hostsColourMerged(model, globalIds)) return refuse(modelId, 'colourMerged');
  const stamps = stamp(modelId, targets);
  const epoch = disposals;

  try {
    const sub = serializeEntitySubgraph(store, view, { targets });
    if (sub.unreadable.length > 0) return refuse(modelId, 'unreadable');
    const walked = performance.now();
    // Awaited only while the worker or the wire is still starting, so a warm
    // request is posted within the commit that asked for it.
    const pendingWorker = clientFor(configFor(state, model));
    const worker = pendingWorker instanceof Promise ? await pendingWorker : pendingWorker;
    const pendingWire = styleWireFor(worker, store);
    const wire = pendingWire instanceof Promise ? await pendingWire : pendingWire;
    const styled = performance.now();
    const result = await worker.remesh({
      buffer: sub.bytes,
      targets: Uint32Array.from(targets),
      frame,
      ...filterStyleWire(wire.styleIds, wire.styleColors, sub.ids),
      materialElementIds: wire.materialElementIds,
      materialColorCounts: wire.materialColorCounts,
      materialColors: wire.materialColors,
    });
    const meshed = performance.now();
    if (!isCurrent(get, modelId, store, stamps, targets)) return { status: 'stale' };
    const current = get().models.get(modelId)!;
    const framed = await toRenderFrame(result.meshes, current, store, get().georefMutations.get(modelId));
    if (!framed.ok) return refuse(modelId, 'alignment');
    if (!isCurrent(get, modelId, store, stamps, targets)) return { status: 'stale' };
    const byGlobalId = groupByGlobalId(globalIds, framed.meshes, framed.meshes);
    const preAligned = framed.preAligned
      ? groupByGlobalId<PreAlignmentMeshBaseline>(globalIds, framed.meshes, framed.preAligned)
      : undefined;
    get().replaceEntityMeshes(modelId, byGlobalId, preAligned);
    if (options.mirror) {
      for (const id of targets) {
        const meshes = byGlobalId.get(toGlobalIdFromModels(get().models, modelId, id));
        if (meshes?.length) get().mirrorEntityGeometry(modelId, id, meshes);
      }
    }
    for (const key of noticed) if (key.startsWith(`${modelId}:`)) noticed.delete(key);
    const end = performance.now();
    return {
      status: 'applied',
      globalIds: [...globalIds],
      csgFailures: result.csgFailures,
      ms: {
        walk: walked - start, styles: styled - walked, worker: meshed - styled,
        prepass: result.ms.prepass, produce: result.ms.produce, frame: end - meshed, total: end - start,
      },
    };
  } catch (error) {
    // The worker was terminated on purpose (another model unloaded) while
    // this ran: ask again on a fresh one unless the request went stale anyway.
    if (disposals !== epoch) {
      return isCurrent(get, modelId, store, stamps, targets) ? remesh(get, modelId, targets, cause, options) : { status: 'stale' };
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error('[remesh] failed:', error);
    notice(modelId, 'remesh.failed', { message });
    return { status: 'failed', message };
  }
}
