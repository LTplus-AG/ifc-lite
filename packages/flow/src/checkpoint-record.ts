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
  /** Graph structure, params, capabilities and Player inputs; layout excluded; names and labels bind default write targets. */
  readonly graphDigest: string;
  /** Host-supplied digest of what the run read (model content hashes, input files). */
  readonly sourceDigest: string;
  readonly reviewNodes: readonly string[];
  /** Digest of the proposal and all restored outputs: an approval binds this complete snapshot. */
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

interface ReviewRegistry { get(type: string): { readonly review?: 'required' } | undefined }

/** What a resume must match: the graph minus layout, plus the Player inputs it runs with. */
export function graphDigest(doc: FlowDocument, inputs: Readonly<Record<string, unknown>> = {}, registry?: ReviewRegistry): string {
  return digest({
    id: doc.id,
    name: doc.name,
    capabilities: doc.capabilities,
    edges: doc.edges,
    inputs: doc.inputs,
    outputs: doc.outputs,
    maxCross: doc.maxCross,
    nodes: doc.nodes.map(({ id, type, label, params, lacing, tracking, trackingKey }) => ({ id, type, label, params, lacing, tracking, trackingKey })),
    player: inputs,
    reviewPolicy: registry ? doc.nodes.map(node => [node.id, registry.get(node.type)?.review ?? null]) : null,
  });
}

export function nonPortable(value: unknown, path: string, out: string[]): void {
  const pending: Array<[unknown, string, number, boolean?]> = [[value, path, 0]];
  const active = new Set<object>();
  let work = 0;
  while (pending.length > 0 && out.length < 20) {
    const [v, p, depth, exiting] = pending.pop()!;
    if (exiting) { active.delete(v as object); continue; }
    if (++work > 100_000 || depth > 256) { out.push(`${p} (JSON traversal limit)`); break; }
    if (v !== null && typeof v === 'object') {
      if (active.has(v)) { out.push(`${p} (cycle)`); continue; }
      active.add(v); pending.push([v, p, depth, true]);
    }
    if (v === null || typeof v === 'string' || typeof v === 'boolean') continue;
    if (typeof v === 'number') { if (!Number.isFinite(v)) out.push(p); continue; }
    if (Array.isArray(v)) { v.forEach((child, i) => pending.push([child, `${p}[${i}]`, depth + 1])); continue; }
    // Plain objects only, from any realm: a class instance, Map, Date or function is not data.
    const proto: unknown = typeof v === 'object' ? Object.getPrototypeOf(v) : undefined;
    const plain = Object.prototype.toString.call(v) === '[object Object]' && (proto === null || (typeof proto === 'object' && Object.getPrototypeOf(proto) === null));
    if (!plain) { out.push(p); continue; }
    // An undefined property is absent in JSON, which is what it means here too.
    for (const [key, child] of Object.entries(v as Record<string, unknown>)) if (child !== undefined) pending.push([child, `${p}.${key}`, depth + 1]);
  }
}

function toPortable(data: FlowData, path: string, problems: string[]): PortableFlowData {
  if (data.kind === 'item') { nonPortable(data.value, path, problems); return { kind: 'item', value: data.value }; }
  if (data.kind === 'list') { nonPortable(data.items, path, problems); return { kind: 'list', items: data.items }; }
  const branches = [...data.branches.entries()];
  nonPortable(branches, path, problems);
  return { kind: 'group', branches };
}

/** Every saved port is a portable container, including outputs outside the reviewed proposal. */
export function validPortableOutputs(outputs: Readonly<Record<string, Readonly<Record<string, unknown>>>>): boolean {
  const problems: string[] = [];
  for (const [node, ports] of Object.entries(outputs)) for (const [port, value] of Object.entries(ports)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const data = value as Record<string, unknown>;
    if (data.kind === 'item') { if (!Object.hasOwn(data, 'value')) return false; nonPortable(data.value, `${node}.${port}`, problems); }
    else if (data.kind === 'list') { if (!Array.isArray(data.items)) return false; nonPortable(data.items, `${node}.${port}`, problems); }
    else if (data.kind === 'group') {
      if (!Array.isArray(data.branches) || !data.branches.every(branch => Array.isArray(branch) && branch.length === 2 && typeof branch[0] === 'string' && Array.isArray(branch[1]))) return false;
      if (new Set(data.branches.map(branch => branch[0])).size !== data.branches.length) return false;
      nonPortable(data.branches, `${node}.${port}`, problems);
    } else return false;
    if (problems.length) return false;
  }
  return true;
}

export function fromPortable(data: PortableFlowData): FlowData {
  if (data.kind === 'item') return { kind: 'item', value: data.value };
  if (data.kind === 'list') return { kind: 'list', items: data.items };
  return { kind: 'group', branches: new Map(data.branches) };
}

function portableOutputs(outputs: RunResult['outputs']): PortableOutputs {
  const problems: string[] = [];
  const out: Record<string, Record<string, PortableFlowData>> = Object.create(null);
  for (const [nodeId, ports] of outputs) {
    out[nodeId] = Object.create(null);
    for (const [port, data] of ports) out[nodeId][port] = toPortable(data, `${nodeId}.${port}`, problems);
  }
  if (problems.length > 0) throw new CheckpointNotPortableError(problems);
  return JSON.parse(JSON.stringify(out)) as PortableOutputs;
}

export function proposalDigestOf(outputs: PortableOutputs, reviewNodes: readonly string[]): string {
  return digest({ reviewNodes, outputs });
}

export interface CreateCheckpointInput {
  readonly doc: FlowDocument;
  readonly registry: ReviewRegistry;
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
  const problems: string[] = [];
  if (input.budget !== undefined) nonPortable(input.budget, 'budget', problems);
  if (problems.length) throw new CheckpointNotPortableError(problems);
  const outputs = portableOutputs(result.outputs);
  const graph = graphDigest(doc, input.inputs, input.registry);
  if (pausedRunGraphs.get(result) !== graph) {
    throw new Error('the checkpoint graph and Player inputs must match the actual paused run');
  }
  const proposal = proposalDigestOf(outputs, result.review);
  const now = input.now ?? Date.now();
  if (!Number.isFinite(now)) throw new Error('the checkpoint timestamp must be finite');
  return {
    version: CHECKPOINT_VERSION,
    id: globalThis.crypto.randomUUID(),
    graphId: doc.id,
    graphName: doc.name,
    graphDigest: graph,
    sourceDigest: input.sourceDigest,
    reviewNodes: [...result.review],
    proposalDigest: proposal,
    outputs,
    ...(input.budget !== undefined ? { budget: JSON.parse(JSON.stringify(input.budget)) as unknown } : {}),
    state: 'prepared',
    createdAt: now,
    updatedAt: now,
  };
}

/** Decode a detached snapshot for inspection or an owned resume. */
function restoreMap(checkpoint: FlowCheckpoint): Map<string, Map<string, FlowData>> {
  if (!validPortableOutputs(checkpoint.outputs)
    || proposalDigestOf(checkpoint.outputs, checkpoint.reviewNodes) !== checkpoint.proposalDigest) {
    throw new Error('the checkpoint outputs no longer match their reviewed snapshot');
  }
  const outputs = JSON.parse(JSON.stringify(checkpoint.outputs)) as PortableOutputs;
  const out = new Map<string, Map<string, FlowData>>();
  for (const [nodeId, ports] of Object.entries(outputs)) {
    out.set(nodeId, new Map(Object.entries(ports).map(([port, data]) => [port, fromPortable(data)])));
  }
  return out;
}

const pausedRunGraphs = new WeakMap<object, string>();

/** Internal: bind checkpoint creation to the graph and Player inputs used at run entry. */
export function registerPausedRun(result: RunResult, graphDigestAtEntry: string): void {
  pausedRunGraphs.set(result, graphDigestAtEntry);
}

const authorizedResumes = new WeakMap<object, { graph: string; outputs: string; expires: number }>();
const ownedClaims = new WeakMap<object, string>();

/** Internal: only a successful CAS claim yields a process-local ownership receipt. */
export function registerOwnedClaim(checkpoint: FlowCheckpoint): void {
  ownedClaims.set(checkpoint, digest({ id: checkpoint.id, graph: checkpoint.graphDigest,
    source: checkpoint.sourceDigest, proposal: checkpoint.proposalDigest, claim: checkpoint.claim }));
}

/** Scheduler-only boundary: raw, changed, expired or reused maps cannot bypass review. */
export function consumeReviewedResume(outputs: ReadonlyMap<string, ReadonlyMap<string, FlowData>>, doc: FlowDocument,
  inputs: Readonly<Record<string, unknown>>, registry: ReviewRegistry): Map<string, Map<string, FlowData>> {
  const authorization = authorizedResumes.get(outputs);
  if (!authorization || authorization.expires <= Date.now()
    || authorization.graph !== graphDigest(doc, inputs, registry)
    || authorization.outputs !== digest(portableOutputs(outputs))) {
    throw new Error('resume requires unchanged outputs from an actively claimed, approved checkpoint');
  }
  authorizedResumes.delete(outputs);
  // Own a detached snapshot before any node can await or mutate caller-owned data.
  const snapshot = JSON.parse(JSON.stringify(portableOutputs(outputs))) as PortableOutputs;
  return new Map(Object.entries(snapshot).map(([node, ports]) =>
    [node, new Map(Object.entries(ports).map(([port, data]) => [port, fromPortable(data)]))]));
}

/** The `RunOptions.resume` map, only for a reviewed checkpoint with a live claim. */
export function resumeOutputs(checkpoint: FlowCheckpoint, now = Date.now()): Map<string, Map<string, FlowData>> {
  if (checkpoint.state !== 'applying' || checkpoint.review?.decision !== 'approved'
    || checkpoint.review.proposalDigest !== checkpoint.proposalDigest || !checkpoint.claim?.owner
    || !Number.isFinite(now) || !Number.isFinite(checkpoint.claim.leaseUntil) || checkpoint.claim.leaseUntil <= Math.max(now, Date.now())) {
    throw new Error('only an actively claimed, approved checkpoint can supply resume outputs');
  }
  const outputs = restoreMap(checkpoint);
  const ownership = digest({ id: checkpoint.id, graph: checkpoint.graphDigest,
    source: checkpoint.sourceDigest, proposal: checkpoint.proposalDigest, claim: checkpoint.claim });
  if (ownedClaims.get(checkpoint) !== ownership) {
    throw new Error('resume requires the original successful store claim; a persisted or already supplied claim cannot resume');
  }
  ownedClaims.delete(checkpoint);
  authorizedResumes.set(outputs, { graph: checkpoint.graphDigest, outputs: digest(portableOutputs(outputs)),
    expires: checkpoint.claim.leaseUntil });
  return outputs;
}

/** The pending proposal's values, by review node and port, for a review UI or CLI summary. */
export function checkpointProposal(checkpoint: FlowCheckpoint): Map<string, Map<string, FlowData>> {
  const all = restoreMap(checkpoint);
  return new Map(checkpoint.reviewNodes.flatMap((id) => (all.has(id) ? [[id, all.get(id)!] as const] : [])));
}
