/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Evaluation: topological order, per-node memoisation, lifting, and a
 * structured run log. Nothing here touches a model; the host services
 * object is passed through to nodes untouched.
 *
 * Memo keys cover the node type, resolved params, lacing, every input's
 * content digest and — for nodes that declare `reads: 'model'` — the
 * per-model revisions the caller supplies. The caller owns those revisions:
 * it bumps one when the graph's own write nodes touch a model, and when the
 * host reports an external change. Write nodes are never memoised.
 */

import { nodeAvailability, type HostFeatures } from './availability.js';
import { digest, digestFlowData } from './digest.js';
import type { FlowDocument } from './document.js';
import { assemble, planLift, type LiftPlan } from './lift.js';
import { resolveParams, type LaneTracking, type LogLevel, type NodeOutputs, type NodeRegistry } from './registry.js';
import { ORPHAN_NODE_ID, removeOrphanedSets, removeSet, trackingKeyOf } from './orphans.js';
import { noopOutputs, prepareInputs } from './prepare.js';
import { emptyTrackedSet, planTracking, type TrackingPlan, type TrackingStore } from './tracking.js';
import type { FlowData } from './values.js';

export const DEFAULT_MAX_CROSS = 100_000;

export interface RunLogEntry {
  readonly nodeId: string;
  readonly laneKey: string | null;
  readonly level: LogLevel;
  readonly message: string;
}

export type NodeStatus = 'ok' | 'memo' | 'noop' | 'skipped' | 'error';

export interface NodeReport {
  readonly nodeId: string;
  readonly status: NodeStatus;
  readonly durationMs: number;
  readonly lanes: number;
  readonly laneErrors: number;
  readonly missing: Readonly<Record<string, readonly string[]>>;
  readonly warnings: readonly string[];
  readonly error?: string;
  /** Tracked nodes: what the run did to the node's element set. */
  readonly tracking?: { readonly created: number; readonly updated: number; readonly kept: number; readonly removed: number };
}

export interface GraphOutputValue {
  readonly label: string;
  readonly nodeId: string;
  readonly port: string;
  readonly data: FlowData | undefined;
}

export interface RunResult {
  readonly ok: boolean;
  /** Number of write nodes that ran; the caller bumps its model revision when non-zero. */
  readonly writes: number;
  /** Every node's outputs by port, for inspectors. */
  readonly outputs: ReadonlyMap<string, ReadonlyMap<string, FlowData>>;
  /** The document's declared outputs, in order. */
  readonly graphOutputs: readonly GraphOutputValue[];
  readonly reports: readonly NodeReport[];
  readonly log: readonly RunLogEntry[];
}

/** Reusable across runs of the same document; keyed by node id. */
export class MemoCache {
  private readonly entries = new Map<string, { key: string; outputs: ReadonlyMap<string, FlowData> }>();
  /**
   * Bumped by the scheduler after every write node, and part of every
   * model-reading memo key: a read behind a write in the same run, and any
   * read in a later run, sees a model that changed and recomputes.
   */
  writeGeneration = 0;

  get(nodeId: string, key: string): ReadonlyMap<string, FlowData> | undefined {
    const e = this.entries.get(nodeId);
    return e && e.key === key ? e.outputs : undefined;
  }

  set(nodeId: string, key: string, outputs: ReadonlyMap<string, FlowData>): void {
    this.entries.set(nodeId, { key, outputs });
  }

  invalidate(nodeId?: string): void {
    if (nodeId === undefined) this.entries.clear();
    else this.entries.delete(nodeId);
  }
}

export interface RunOptions<H> {
  readonly host: H;
  readonly registry: NodeRegistry<H>;
  /** Player overrides keyed `${nodeId}.${param}`. */
  readonly inputs?: Readonly<Record<string, unknown>>;
  readonly modelRevisions?: Readonly<Record<string, number>>;
  readonly features?: HostFeatures;
  readonly cache?: MemoCache;
  /** Where tracked nodes read and persist their element sets; absent = every lane is a fresh create. */
  readonly tracking?: TrackingStore;
  readonly signal?: AbortSignal;
}

export class FlowCycleError extends Error {
  constructor(readonly nodeIds: readonly string[]) {
    super(`flow has a cycle through ${nodeIds.join(' → ')}`);
    this.name = 'FlowCycleError';
  }
}

/** Kahn's algorithm; stable with respect to document node order. */
export function topologicalOrder(doc: FlowDocument): string[] {
  const indegree = new Map<string, number>(doc.nodes.map((n) => [n.id, 0]));
  const out = new Map<string, string[]>(doc.nodes.map((n) => [n.id, []]));
  for (const e of doc.edges) {
    out.get(e.from[0])!.push(e.to[0]);
    indegree.set(e.to[0], (indegree.get(e.to[0]) ?? 0) + 1);
  }
  const ready = doc.nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const next of out.get(id)!) {
      const d = indegree.get(next)! - 1;
      indegree.set(next, d);
      if (d === 0) ready.push(next);
    }
  }
  if (order.length !== doc.nodes.length) {
    throw new FlowCycleError(doc.nodes.map((n) => n.id).filter((id) => !order.includes(id)));
  }
  return order;
}

export async function runFlow<H>(doc: FlowDocument, opts: RunOptions<H>): Promise<RunResult> {
  const registry = opts.registry as NodeRegistry<unknown>;
  const order = topologicalOrder(doc);
  const outputs = new Map<string, Map<string, FlowData>>();
  const reports: NodeReport[] = [];
  const log: RunLogEntry[] = [];
  const failed = new Set<string>();
  const nodesById = new Map(doc.nodes.map((n) => [n.id, n]));
  const maxCross = doc.maxCross ?? DEFAULT_MAX_CROSS;
  let writesThisRun = 0;

  for (const nodeId of order) {
    const node = nodesById.get(nodeId)!;
    const started = Date.now();
    const report = (partial: Omit<NodeReport, 'nodeId' | 'durationMs'>) => reports.push({ nodeId, durationMs: Date.now() - started, ...partial });
    const fail = (error: string, lanes = 0) => {
      failed.add(nodeId);
      log.push({ nodeId, laneKey: null, level: 'error', message: error });
      report({ status: 'error', lanes, laneErrors: 0, missing: {}, warnings: [], error });
    };

    const def = registry.get(node.type);
    if (!def) {
      fail(`unknown node type "${node.type}"`);
      continue;
    }
    const { inputs, problems, skipped } = prepareInputs(doc, node, def, registry, outputs, failed);
    if (skipped) {
      failed.add(nodeId);
      report({ status: 'skipped', lanes: 0, laneErrors: 0, missing: {}, warnings: [], error: 'an upstream node failed' });
      continue;
    }
    if (problems.length > 0) {
      fail(problems.join('; '));
      continue;
    }

    const overrides: Record<string, unknown> = {};
    for (const p of def.params) {
      const v = opts.inputs?.[`${nodeId}.${p.name}`];
      if (v !== undefined) overrides[p.name] = v;
    }
    const params = resolveParams(def, { ...node.params, ...overrides });
    const lacing = node.lacing ?? 'shortest';

    if (opts.features) {
      const avail = nodeAvailability(def, node.type, opts.features);
      if (avail.status === 'unavailable') {
        fail(avail.reasons.join('; '));
        continue;
      }
      if (avail.status === 'noop') {
        outputs.set(nodeId, noopOutputs(def, inputs));
        report({ status: 'noop', lanes: 0, laneErrors: 0, missing: {}, warnings: avail.reasons });
        continue;
      }
    }

    const memoKey = def.writes
      ? undefined
      : digest({
          type: def.type,
          params,
          lacing,
          inputs: inputs.map((i) => (i.data ? digestFlowData(i.data) : null)),
          rev: def.reads === 'model' ? { ...opts.modelRevisions, '': opts.cache?.writeGeneration ?? 0 } : undefined,
        });
    if (memoKey && opts.cache) {
      const hit = opts.cache.get(nodeId, memoKey);
      if (hit) {
        outputs.set(nodeId, new Map(hit));
        report({ status: 'memo', lanes: 0, laneErrors: 0, missing: {}, warnings: [] });
        continue;
      }
    }

    let plan: LiftPlan;
    try {
      plan = planLift(inputs, { lacing, maxCross, laneKeyPort: def.laneKeyPort });
    } catch (err) {
      fail((err as Error).message);
      continue;
    }
    for (const w of plan.warnings) log.push({ nodeId, laneKey: null, level: 'warn', message: w });
    for (const [port, keys] of Object.entries(plan.missing)) {
      log.push({ nodeId, laneKey: null, level: 'warn', message: `input "${port}" has no branch for keys: ${keys.join(', ')}` });
    }

    // Tracked nodes: decide per lane what to do against last run's set.
    let trackingPlan: TrackingPlan | undefined;
    const trackingKey = trackingKeyOf(doc, node);
    if (def.tracked) {
      let previous = opts.tracking?.load(trackingKey) ?? emptyTrackedSet(trackingKey);
      // A set another node type made under this key is not adopted: its
      // elements go out through THAT type's `remove`, and this node starts
      // from an empty set. Planning against it would overwrite `nodeType`
      // and leave the old type's elements to nobody.
      if (previous.nodeType !== undefined && previous.nodeType !== node.type) {
        const gone = await removeSet(previous, registry, opts.host, opts.signal, log, nodeId);
        if (gone.removed > 0) {
          writesThisRun += 1;
          if (opts.cache) opts.cache.writeGeneration += 1;
        }
        if (gone.rest !== undefined) {
          opts.tracking?.save(gone.rest);
          fail(`the tracked set "${trackingKey}" was made by node type "${previous.nodeType}" and ${Object.keys(gone.rest.entries).length} of its element(s) could not be removed; give this node its own tracking key`);
          continue;
        }
        // Persisted now, not with the node's own result: if the node fails
        // below, the store must not still name elements that are gone.
        previous = emptyTrackedSet(trackingKey);
        opts.tracking?.save(previous);
      }
      const desired = plan.lanes
        .filter((l) => !l.nullLane)
        .map((l) => ({ laneKey: l.laneKey ?? '', digest: digest({ args: l.args, params }) }));
      trackingPlan = planTracking(previous, desired, node.tracking ?? 'update');
      for (const k of trackingPlan.duplicateLanes) log.push({ nodeId, laneKey: k, level: 'warn', message: 'duplicate lane key; only the first lane is tracked' });
    }
    const laneTracking = (laneKey: string | null): LaneTracking | undefined => {
      if (!trackingPlan) return undefined;
      const k = laneKey ?? '';
      const c = trackingPlan.create.find((e) => e.laneKey === k);
      if (c) return { action: 'create', globalId: c.globalId };
      const u = trackingPlan.update.find((e) => e.laneKey === k);
      if (u) return { action: 'update', globalId: u.globalId };
      const kept = trackingPlan.keep.find((e) => e.laneKey === k);
      return kept ? { action: 'keep', globalId: kept.globalId } : undefined;
    };
    const makeCtx = (laneKey: string | null, tracking?: LaneTracking) => ({
      host: opts.host,
      laneKey,
      tracking,
      signal: opts.signal,
      log: (level: LogLevel, message: string) => log.push({ nodeId, laneKey, level, message }),
    });

    const results: (NodeOutputs | null)[] = [];
    let laneErrors = 0;
    let nodeError: string | undefined;
    const seenLanes = new Set<string>();
    // Lanes skipped as duplicates yield null like a failed lane but must not
    // count as one: counting them dropped the FIRST lane's fresh entry, and
    // the next run then planned `create` against an element that existed.
    const skippedDuplicates = new Set<number>();
    for (const lane of plan.lanes) {
      if (opts.signal?.aborted) {
        nodeError = 'aborted';
        break;
      }
      if (lane.nullLane) {
        results.push(null);
        continue;
      }
      const duplicate = trackingPlan !== undefined && seenLanes.has(lane.laneKey ?? '');
      seenLanes.add(lane.laneKey ?? '');
      if (duplicate) {
        skippedDuplicates.add(results.length);
        results.push(null);
        continue;
      }
      const ctx = makeCtx(lane.laneKey, laneTracking(lane.laneKey));
      try {
        results.push(await def.run(ctx, lane.args, params));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!plan.lifted) {
          nodeError = message;
          break;
        }
        laneErrors += 1;
        log.push({ nodeId, laneKey: lane.laneKey, level: 'error', message });
        results.push(null);
      }
    }
    if (nodeError !== undefined) {
      fail(nodeError, plan.lanes.length);
      continue;
    }
    let removeErrors = 0;
    if (trackingPlan) {
      for (const gone of trackingPlan.remove) {
        try {
          await def.remove?.(makeCtx(gone.laneKey), gone.globalId);
        } catch (err) {
          removeErrors += 1;
          log.push({ nodeId, laneKey: gone.laneKey, level: 'error', message: `remove ${gone.globalId}: ${err instanceof Error ? err.message : String(err)}` });
        }
      }
      // A lane that failed keeps its previous entry, so the next run retries
      // it instead of forgetting an element that may still exist.
      const failedLanes = new Set(
        plan.lanes.filter((l, i) => results[i] === null && !l.nullLane && !skippedDuplicates.has(i)).map((l) => l.laneKey ?? ''),
      );
      const entries = { ...trackingPlan.next.entries };
      const previous = opts.tracking?.load(trackingKey)?.entries ?? {};
      for (const k of failedLanes) {
        if (previous[k]) entries[k] = previous[k];
        else delete entries[k];
      }
      opts.tracking?.save({ ...trackingPlan.next, entries, nodeType: node.type });
    }
    let assembled: Map<string, FlowData>;
    try {
      assembled = assemble(plan, def.outputs, results);
    } catch (err) {
      fail((err as Error).message, plan.lanes.length);
      continue;
    }
    outputs.set(nodeId, assembled);
    if (def.writes) {
      writesThisRun += 1;
      if (opts.cache) opts.cache.writeGeneration += 1;
    }
    if (memoKey && opts.cache) opts.cache.set(nodeId, memoKey, assembled);
    report({
      status: 'ok',
      lanes: plan.lanes.length,
      laneErrors: laneErrors + removeErrors,
      missing: plan.missing,
      warnings: plan.warnings,
      tracking: trackingPlan
        ? { created: trackingPlan.create.length, updated: trackingPlan.update.length, kept: trackingPlan.keep.length, removed: trackingPlan.remove.length - removeErrors }
        : undefined,
    });
  }

  const orphans = opts.signal?.aborted ? { removed: 0, errors: 0 } : await removeOrphanedSets(doc, opts.host, opts.tracking, registry, log, opts.signal);
  if (orphans.errors > 0) failed.add(ORPHAN_NODE_ID);
  if (orphans.removed > 0) {
    writesThisRun += 1;
    if (opts.cache) opts.cache.writeGeneration += 1;
  }

  const graphOutputs = doc.outputs.map((o) => ({ label: o.label, nodeId: o.nodeId, port: o.port, data: outputs.get(o.nodeId)?.get(o.port) }));
  return { ok: failed.size === 0, writes: writesThisRun, outputs, graphOutputs, reports, log };
}
