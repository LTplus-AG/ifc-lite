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
import type { FlowDocument, FlowNode } from './document.js';
import { assemble, planLift, type LiftInput, type LiftPlan } from './lift.js';
import { resolveParams, type LogLevel, type NodeDef, type NodeOutputs, type NodeRegistry } from './registry.js';
import { isAssignable, item, type FlowData } from './values.js';

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

interface Prepared {
  readonly inputs: LiftInput[];
  readonly problems: string[];
  readonly skipped: boolean;
}

function prepareInputs(
  doc: FlowDocument,
  node: FlowNode,
  def: NodeDef<unknown>,
  registry: NodeRegistry<unknown>,
  outputs: Map<string, Map<string, FlowData>>,
  failed: Set<string>,
): Prepared {
  const problems: string[] = [];
  let skipped = false;
  const inputs: LiftInput[] = def.inputs.map((port) => {
    const edge = doc.edges.find((e) => e.to[0] === node.id && e.to[1] === port.name);
    if (!edge) {
      if (!port.optional) problems.push(`required input "${port.name}" is not connected`);
      return { port, data: undefined };
    }
    const [srcId, srcPort] = edge.from;
    if (failed.has(srcId)) skipped = true;
    const srcNode = doc.nodes.find((n) => n.id === srcId);
    const srcDef = srcNode ? registry.get(srcNode.type) : undefined;
    const srcPortDef = srcDef?.outputs.find((p) => p.name === srcPort);
    if (!srcPortDef) problems.push(`edge from ${srcId}.${srcPort}: no such output`);
    else if (!isAssignable(srcPortDef.type, port.type)) {
      problems.push(`edge from ${srcId}.${srcPort} (${srcPortDef.type.kind}) cannot feed "${port.name}" (${port.type.kind})`);
    }
    return { port, data: outputs.get(srcId)?.get(srcPort) };
  });
  return { inputs, problems, skipped };
}

function noopOutputs(def: NodeDef<unknown>, inputs: readonly LiftInput[]): Map<string, FlowData> {
  // A no-op node passes through any input whose name matches an output
  // (so `viewer.colorize(entities) → entities` still chains), else empties.
  const out = new Map<string, FlowData>();
  for (const port of def.outputs) {
    const same = inputs.find((i) => i.port.name === port.name)?.data;
    out.set(port.name, same ?? (port.type.access === 'item' ? item(null) : port.type.access === 'list' ? { kind: 'list', items: [] } : { kind: 'group', branches: new Map() }));
  }
  return out;
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

    const results: (NodeOutputs | null)[] = [];
    let laneErrors = 0;
    let nodeError: string | undefined;
    for (const lane of plan.lanes) {
      if (opts.signal?.aborted) {
        nodeError = 'aborted';
        break;
      }
      if (lane.nullLane) {
        results.push(null);
        continue;
      }
      const ctx = {
        host: opts.host,
        laneKey: lane.laneKey,
        signal: opts.signal,
        log: (level: LogLevel, message: string) => log.push({ nodeId, laneKey: lane.laneKey, level, message }),
      };
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
    report({ status: 'ok', lanes: plan.lanes.length, laneErrors, missing: plan.missing, warnings: plan.warnings });
  }

  const graphOutputs = doc.outputs.map((o) => ({ label: o.label, nodeId: o.nodeId, port: o.port, data: outputs.get(o.nodeId)?.get(o.port) }));
  return { ok: failed.size === 0, writes: writesThisRun, outputs, graphOutputs, reports, log };
}
