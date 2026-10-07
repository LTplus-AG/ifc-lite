/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Review checkpoints (#6923): the durable, portable record of a run that
 * paused at a node declaring `review: 'required'`.
 *
 * A checkpoint holds what a later resume needs and nothing host-specific:
 * the outputs of every node that completed before the pause (plain JSON, so a
 * viewer checkpoint can be resumed by a headless host and the other way
 * round), the digest of the graph and Player inputs it ran with, a
 * host-supplied digest of the sources it read, the digest of the proposal a
 * reviewer must approve, and an opaque budget state so a resume keeps
 * spending from the same root budget. A value that is not plain JSON (a
 * viewer-only handle, a Map, a function) makes the run uncheckpointable,
 * named by node and port, rather than silently dropped.
 *
 * State transitions live in `checkpoint-state.ts`.
 */

import { digest } from './digest.js';
import type { FlowDocument } from './document.js';
import type { RunResult } from './scheduler.js';
import type { FlowData } from './values.js';

export const CHECKPOINT_VERSION = 1;

/**
 * `prepared` awaits review; `reviewed` is approved and claimable once;
 * `applying` is claimed by one owner under a lease; `completed` resumed
 * cleanly; `partially-committed` resumed with failures or lost its owner
 * mid-resume, so downstream effects may be partial and the checkpoint can
 * never be applied again; `rejected` was declined.
 */
export type CheckpointState = 'prepared' | 'reviewed' | 'rejected' | 'applying' | 'partially-committed' | 'completed';

export type PortableFlowData =
  | { readonly kind: 'item'; readonly value: unknown }
  | { readonly kind: 'list'; readonly items: readonly unknown[] }
  | { readonly kind: 'group'; readonly branches: readonly (readonly [string, readonly unknown[]])[] };

/** Node id → port → value. */
export type PortableOutputs = Readonly<Record<string, Readonly<Record<string, PortableFlowData>>>>;

export interface FlowCheckpoint {
  readonly version: typeof CHECKPOINT_VERSION;
  readonly id: string;
  readonly graphId: string;
  readonly graphName: string;
  /** Graph structure, params, capabilities and Player inputs; layout and labels excluded. */
  readonly graphDigest: string;
  /** Host-supplied digest of what the run read (model content hashes, input files). */
  readonly sourceDigest: string;
  readonly reviewNodes: readonly string[];
  /** Digest of the review nodes' outputs: an approval must name exactly this. */
  readonly proposalDigest: string;
  readonly outputs: PortableOutputs;
  /** Host budget state (e.g. an `@ifc-lite/ai` root budget) a resume continues from. */
  readonly budget?: unknown;
  readonly state: CheckpointState;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly review?: { readonly decision: 'approved' | 'rejected'; readonly proposalDigest: string; readonly at: number };
  readonly claim?: { readonly owner: string; readonly leaseUntil: number; readonly at: number };
  readonly outcome?: { readonly ok: boolean; readonly at: number; readonly message?: string };
}

export class CheckpointNotPortableError extends Error {
  constructor(readonly paths: readonly string[]) {
    super(`the run cannot be checkpointed: ${paths.slice(0, 5).join(', ')} ${paths.length === 1 ? 'is' : 'are'} not plain JSON values`);
    this.name = 'CheckpointNotPortableError';
  }
}

/** What a resume must match: the graph minus layout, plus the Player inputs it runs with. */
export function graphDigest(doc: FlowDocument, inputs: Readonly<Record<string, unknown>> = {}): string {
  return digest({
    capabilities: doc.capabilities,
    edges: doc.edges,
    inputs: doc.inputs,
    outputs: doc.outputs,
    maxCross: doc.maxCross,
    nodes: doc.nodes.map(({ id, type, params, lacing, tracking, trackingKey }) => ({ id, type, params, lacing, tracking, trackingKey })),
    player: inputs,
  });
}

function nonPortable(value: unknown, path: string, out: string[]): void {
  const pending: Array<[unknown, string]> = [[value, path]];
  while (pending.length > 0 && out.length < 20) {
    const [v, p] = pending.pop()!;
    if (v === null || typeof v === 'string' || typeof v === 'boolean') continue;
    if (typeof v === 'number') { if (!Number.isFinite(v)) out.push(p); continue; }
    if (Array.isArray(v)) { v.forEach((child, i) => pending.push([child, `${p}[${i}]`])); continue; }
    // Plain objects only, from any realm: a class instance, Map, Date or function is not data.
    const proto: unknown = typeof v === 'object' ? Object.getPrototypeOf(v) : undefined;
    const plain = Object.prototype.toString.call(v) === '[object Object]' && (proto === null || (typeof proto === 'object' && Object.getPrototypeOf(proto) === null));
    if (!plain) { out.push(p); continue; }
    // An undefined property is absent in JSON, which is what it means here too.
    for (const [key, child] of Object.entries(v as Record<string, unknown>)) if (child !== undefined) pending.push([child, `${p}.${key}`]);
  }
}

function toPortable(data: FlowData, path: string, problems: string[]): PortableFlowData {
  if (data.kind === 'item') { nonPortable(data.value, path, problems); return { kind: 'item', value: data.value }; }
  if (data.kind === 'list') { nonPortable(data.items, path, problems); return { kind: 'list', items: data.items }; }
  const branches = [...data.branches.entries()];
  nonPortable(branches, path, problems);
  return { kind: 'group', branches };
}

export function fromPortable(data: PortableFlowData): FlowData {
  if (data.kind === 'item') return { kind: 'item', value: data.value };
  if (data.kind === 'list') return { kind: 'list', items: data.items };
  return { kind: 'group', branches: new Map(data.branches) };
}

function portableOutputs(outputs: RunResult['outputs']): PortableOutputs {
  const problems: string[] = [];
  const out: Record<string, Record<string, PortableFlowData>> = {};
  for (const [nodeId, ports] of outputs) {
    out[nodeId] = {};
    for (const [port, data] of ports) out[nodeId][port] = toPortable(data, `${nodeId}.${port}`, problems);
  }
  if (problems.length > 0) throw new CheckpointNotPortableError(problems);
  return out;
}

export function proposalDigestOf(outputs: PortableOutputs, reviewNodes: readonly string[]): string {
  return digest(reviewNodes.map((id) => [id, outputs[id] ?? null]));
}

export interface CreateCheckpointInput {
  readonly doc: FlowDocument;
  /** A run that paused for review (`result.review` non-empty) without failures. */
  readonly result: RunResult;
  readonly sourceDigest: string;
  readonly inputs?: Readonly<Record<string, unknown>>;
  readonly budget?: unknown;
  readonly now?: number;
}

export function createCheckpoint(input: CreateCheckpointInput): FlowCheckpoint {
  const { doc, result } = input;
  if (result.review.length === 0) throw new Error('the run did not pause for review');
  if (!result.ok) throw new Error('a run with failed nodes cannot be resumed; fix the graph and run it again');
  const outputs = portableOutputs(result.outputs);
  const graph = graphDigest(doc, input.inputs);
  const proposal = proposalDigestOf(outputs, result.review);
  const now = input.now ?? Date.now();
  return {
    version: CHECKPOINT_VERSION,
    id: digest({ graph, source: input.sourceDigest, proposal, now }).slice(0, 32),
    graphId: doc.id,
    graphName: doc.name,
    graphDigest: graph,
    sourceDigest: input.sourceDigest,
    reviewNodes: [...result.review],
    proposalDigest: proposal,
    outputs,
    ...(input.budget !== undefined ? { budget: input.budget } : {}),
    state: 'prepared',
    createdAt: now,
    updatedAt: now,
  };
}

/** The `RunOptions.resume` map for a checkpoint. */
export function resumeOutputs(checkpoint: FlowCheckpoint): Map<string, Map<string, FlowData>> {
  const out = new Map<string, Map<string, FlowData>>();
  for (const [nodeId, ports] of Object.entries(checkpoint.outputs)) {
    out.set(nodeId, new Map(Object.entries(ports).map(([port, data]) => [port, fromPortable(data)])));
  }
  return out;
}

/** The pending proposal's values, by review node and port, for a review UI or CLI summary. */
export function checkpointProposal(checkpoint: FlowCheckpoint): Map<string, Map<string, FlowData>> {
  const all = resumeOutputs(checkpoint);
  return new Map(checkpoint.reviewNodes.flatMap((id) => (all.has(id) ? [[id, all.get(id)!] as const] : [])));
}
