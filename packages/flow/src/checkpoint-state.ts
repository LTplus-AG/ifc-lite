/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Review checkpoint lifecycle (#6923):
 *
 *   prepared ──approve(digest)──▶ reviewed ──claim──▶ applying ──finish──▶ completed
 *       │                                                │  └─finish(failed)─▶ partially-committed
 *       └──reject──▶ rejected                            └─lease expired (recover)─▶ partially-committed
 *
 * Every transition is a pure function that throws a `CheckpointError` when
 * the record is not in the state it requires. `updateCheckpoint` applies one
 * through a store's compare-and-swap write and re-applies it to the fresh
 * record on a conflict, so two tabs or processes racing to claim the same
 * reviewed checkpoint cannot both win: the loser re-reads `applying` and is
 * refused. A claim also re-checks the graph and source digests, so a resume
 * never applies a proposal to a graph or model that changed after review.
 *
 * A checkpoint whose owner vanished mid-resume is not handed to anyone else:
 * the effects it may have committed are unknown, so recovery marks it
 * `partially-committed`, which blocks any further resume until the user runs
 * the graph again as a new root.
 */

import { CHECKPOINT_VERSION, registerOwnedClaim, nonPortable, proposalDigestOf, validPortableOutputs, type CheckpointState, type FlowCheckpoint } from './checkpoint-record.js';

export type CheckpointErrorCode =
  | 'invalid'
  | 'not-prepared'
  | 'not-reviewed'
  | 'digest-mismatch'
  | 'graph-changed'
  | 'sources-changed'
  | 'not-owner'
  | 'conflict';

export class CheckpointError extends Error {
  constructor(readonly code: CheckpointErrorCode, message: string) {
    super(message);
    this.name = 'CheckpointError';
  }
}

const STATES: readonly CheckpointState[] = ['prepared', 'reviewed', 'rejected', 'applying', 'partially-committed', 'completed'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Validate an untrusted checkpoint (a file handed to a headless host, a
 * stored row). The proposal digest is recomputed from the stored outputs, so
 * a bundle whose values were edited after review no longer matches its
 * approval and cannot be claimed.
 */
export function parseCheckpoint(value: unknown): FlowCheckpoint {
  const bad = (why: string): never => { throw new CheckpointError('invalid', `not a Flow review checkpoint: ${why}`); };
  if (!isRecord(value)) return bad('must be an object');
  if (value.version !== CHECKPOINT_VERSION) bad(`unsupported version ${String(value.version)}`);
  for (const key of ['id', 'graphId', 'graphName', 'graphDigest', 'sourceDigest', 'proposalDigest'] as const) {
    if (typeof value[key] !== 'string') bad(`"${key}" must be a string`);
  }
  if (!STATES.includes(value.state as CheckpointState)) bad(`unknown state "${String(value.state)}"`);
  if (!Array.isArray(value.reviewNodes) || value.reviewNodes.length === 0 || !value.reviewNodes.every((n) => typeof n === 'string')) bad('"reviewNodes" must list node ids');
  if (!isRecord(value.outputs) || !Object.values(value.outputs).every(isRecord)) bad('"outputs" must map node ids to ports');
  if (typeof value.createdAt !== 'number' || typeof value.updatedAt !== 'number') bad('timestamps must be numbers');
  if (!validPortableOutputs(value.outputs as Record<string, Record<string, unknown>>)) bad('outputs contain malformed or non-portable flow data');
  if (!Number.isFinite(value.createdAt) || !Number.isFinite(value.updatedAt)) bad('timestamps must be finite');
  if (value.claim !== undefined && (!isRecord(value.claim) || typeof value.claim.owner !== 'string' || !value.claim.owner.trim()
    || !Number.isFinite(value.claim.leaseUntil) || !Number.isFinite(value.claim.at))) bad('invalid claim');
  if (value.review !== undefined && (!isRecord(value.review) || !['approved', 'rejected'].includes(String(value.review.decision))
    || typeof value.review.proposalDigest !== 'string' || !Number.isFinite(value.review.at))) bad('invalid review');
  const problems: string[] = [];
  if (value.budget !== undefined) nonPortable(value.budget, 'budget', problems);
  if (problems.length) bad('budget must be plain JSON');
  const checkpoint = value as unknown as FlowCheckpoint;
  if (proposalDigestOf(checkpoint.outputs, checkpoint.reviewNodes, checkpoint.budget) !== checkpoint.proposalDigest) {
    bad('the proposal values do not match the proposal digest');
  }
  return checkpoint;
}

function requireState(checkpoint: FlowCheckpoint, state: CheckpointState, code: CheckpointErrorCode): void {
  if (checkpoint.state !== state) throw new CheckpointError(code, `the checkpoint is ${checkpoint.state}, not ${state}`);
}

function assertTimestamp(now: number): void {
  if (!Number.isFinite(now)) throw new CheckpointError('invalid', 'the checkpoint timestamp must be finite');
}

/** Approve exactly the proposal the reviewer saw, named by its digest. */
export function approveCheckpoint(checkpoint: FlowCheckpoint, proposalDigest: string, now = Date.now()): FlowCheckpoint {
  assertTimestamp(now);
  requireState(checkpoint, 'prepared', 'not-prepared');
  if (proposalDigest !== checkpoint.proposalDigest) {
    throw new CheckpointError('digest-mismatch', 'the approval names a different proposal than the one awaiting review');
  }
  return { ...checkpoint, state: 'reviewed', updatedAt: now, review: { decision: 'approved', proposalDigest, at: now } };
}

export function rejectCheckpoint(checkpoint: FlowCheckpoint, now = Date.now()): FlowCheckpoint {
  assertTimestamp(now);
  requireState(checkpoint, 'prepared', 'not-prepared');
  return { ...checkpoint, state: 'rejected', updatedAt: now, review: { decision: 'rejected', proposalDigest: checkpoint.proposalDigest, at: now } };
}

export interface ClaimInput {
  readonly owner: string;
  /** The graph and Player inputs the resume will run with (`graphDigest`). */
  readonly graphDigest: string;
  /** What the resume will read, digested the same way as at checkpoint time. */
  readonly sourceDigest: string;
  readonly leaseMs: number;
  readonly now?: number;
}

/** Take single ownership of a reviewed checkpoint for one resume. */
export function claimCheckpoint(checkpoint: FlowCheckpoint, input: ClaimInput): FlowCheckpoint {
  requireState(checkpoint, 'reviewed', 'not-reviewed');
  if (!input.owner.trim()) throw new CheckpointError('invalid', 'the claim owner must be nonempty');
  parseCheckpoint(checkpoint);
  if (checkpoint.review?.decision !== 'approved' || checkpoint.review.proposalDigest !== checkpoint.proposalDigest) {
    throw new CheckpointError('digest-mismatch', 'the approval does not name this proposal');
  }
  if (input.graphDigest !== checkpoint.graphDigest) {
    throw new CheckpointError('graph-changed', 'the graph or its Player inputs changed after review; run it again for a new review');
  }
  if (input.sourceDigest !== checkpoint.sourceDigest) {
    throw new CheckpointError('sources-changed', 'the models or files the run read changed after review; run it again for a new review');
  }
  const now = input.now ?? Date.now();
  if (!Number.isFinite(input.leaseMs) || input.leaseMs <= 0 || !Number.isFinite(now)
    || !Number.isFinite(now + input.leaseMs) || now + input.leaseMs <= now) {
    throw new CheckpointError('invalid', 'the claim needs a finite positive lease and timestamp');
  }
  return { ...checkpoint, state: 'applying', updatedAt: now, claim: { owner: input.owner, leaseUntil: now + input.leaseMs, at: now } };
}

/** Record how the owner's resume ended. A failed resume may have committed some effects. */
export function finishCheckpoint(checkpoint: FlowCheckpoint, owner: string, outcome: { ok: boolean; message?: string }, now = Date.now()): FlowCheckpoint {
  assertTimestamp(now);
  requireState(checkpoint, 'applying', 'not-owner');
  if (checkpoint.claim?.owner !== owner) throw new CheckpointError('not-owner', 'another owner holds this checkpoint');
  return {
    ...checkpoint,
    state: outcome.ok ? 'completed' : 'partially-committed',
    updatedAt: now,
    outcome: { ok: outcome.ok, at: now, ...(outcome.message ? { message: outcome.message } : {}) },
  };
}

/** A claim whose lease ran out without a finish: its effects are unknown, so it can never be applied again. */
export function recoverCheckpoint(checkpoint: FlowCheckpoint, now = Date.now()): FlowCheckpoint | null {
  assertTimestamp(now);
  if (checkpoint.state !== 'applying' || (checkpoint.claim && checkpoint.claim.leaseUntil > now)) return null;
  return {
    ...checkpoint,
    state: 'partially-committed',
    updatedAt: now,
    outcome: { ok: false, at: now, message: 'the resume stopped before it finished; downstream effects may be partial' },
  };
}

export interface StoredCheckpoint {
  readonly checkpoint: FlowCheckpoint;
  readonly revision: number;
}

/** Durable checkpoint storage with compare-and-swap writes. */
export interface CheckpointStore {
  read(id: string): Promise<StoredCheckpoint | null>;
  /** Write when the stored revision still equals `expected` (`null`: must not exist yet); false on conflict. */
  write(checkpoint: FlowCheckpoint, expected: number | null): Promise<boolean>;
}

const CAS_ATTEMPTS = 5;

/** Apply one transition through the store's CAS, re-applying it to the fresh record on conflict. */
export async function updateCheckpoint(store: CheckpointStore, id: string, change: (current: FlowCheckpoint) => FlowCheckpoint): Promise<FlowCheckpoint> {
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const stored = await store.read(id);
    if (!stored) throw new CheckpointError('invalid', `no checkpoint ${id}`);
    const next = change(stored.checkpoint);
    if (await store.write(next, stored.revision)) {
      if (stored.checkpoint.state === 'reviewed' && next.state === 'applying') registerOwnedClaim(next);
      return next;
    }
  }
  throw new CheckpointError('conflict', 'the checkpoint kept changing while it was being updated');
}

/** An in-process store, for tests and single-process hosts. */
export class MemoryCheckpointStore implements CheckpointStore {
  private readonly rows = new Map<string, StoredCheckpoint>();

  async read(id: string): Promise<StoredCheckpoint | null> {
    const row = this.rows.get(id);
    return row ? structuredClone(row) : null;
  }

  async write(checkpoint: FlowCheckpoint, expected: number | null): Promise<boolean> {
    const current = this.rows.get(checkpoint.id);
    if ((current?.revision ?? null) !== expected) return false;
    this.rows.set(checkpoint.id, { checkpoint: structuredClone(checkpoint), revision: (current?.revision ?? 0) + 1 });
    return true;
  }
}
