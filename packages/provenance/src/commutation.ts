/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Commutation certificates for the M4 merge soundness contract (Bet B2.1,
 * docs/vision/moonshots-execution-plan.md Phase 2; docs/vision/
 * moonshots-tech.md M4: "an auto-merge is emitted only with a certificate
 * that the ops commute").
 *
 * Given a base state and two concurrent op sets A and B (one per client),
 * {@link createCommutationCertificate}:
 *
 * 1. computes every op's footprint against the base (merge-model.ts /
 *    footprint.ts) and runs `conflictPredicate` over every cross pair
 *    (one op from A, one from B) -- any conflict means NO certificate, the
 *    pair goes to conflict resolution instead;
 * 2. replays BOTH orders (base + A + B and base + B + A) through the
 *    deterministic op model and requires byte-identical convergence
 *    (`canonicalStateBytes`) -- this is the checkable commutation claim
 *    itself, not an assumption;
 * 3. emits the certificate: op-set summaries (op ids, union writtenNodes,
 *    union region), the epsilon used, and node-hash-v0 Merkle commitments to
 *    the base and the merged state.
 *
 * {@link verifyCommutationCertificate} trusts NOTHING in the artifact: it
 * re-derives footprints, re-checks no-conflict, re-replays both orders, and
 * re-hashes base and merged states, failing on any mismatch -- same
 * philosophy as certificate.ts's `verifyCertificate`.
 *
 * Signatures stay out of scope for v0 (spec node-hash-v0.md decision Q5:
 * reserved slot, actual signing lands with the M4 encrypted final).
 */

import {
  conflictPredicate,
  unionAabb,
  DEFAULT_EPSILON_MM,
  type Aabb,
  type ConflictResult,
  type Footprint,
} from './footprint.js';
import {
  applyOps,
  buildStateDag,
  canonicalStateBytes,
  computeMergeOpFootprint,
  hashModelState,
  OpApplicationError,
  type MergeOp,
  type ModelState,
} from './merge-model.js';

export const COMMUTATION_CERTIFICATE_VERSION = 'commutation-v0';

/** One client's op set, summarized for the certificate. */
export interface OpSetSummary {
  client: string;
  /** In application order. */
  opIds: readonly string[];
  /** Sorted union of every op's writtenNodes (vs the base DAG). */
  writtenNodes: readonly string[];
  /** Union of every op's region, or null if no op carried one. */
  region: Aabb | null;
}

export interface CommutationCertificate {
  version: typeof COMMUTATION_CERTIFICATE_VERSION;
  /** Op model the claim is stated over. */
  model: 'merge-model-v0';
  /** Epsilon (mm) the no-conflict check was run at. */
  epsilonMm: number;
  /** node-hash-v0 Merkle root of the base state. */
  baseRootHash: string;
  /** Merkle root of the merged state -- BOTH orders produce it. */
  mergedRootHash: string;
  a: OpSetSummary;
  b: OpSetSummary;
}

/** A cross pair the predicate flagged. */
export interface OpConflict {
  aOpId: string;
  bOpId: string;
  result: ConflictResult;
}

export type CommutationOutcome =
  | { ok: true; certificate: CommutationCertificate; merged: ModelState }
  | { ok: false; reason: 'conflict'; conflicts: readonly OpConflict[] }
  /** Predicate said no conflict but one order failed to apply -- an
   *  unsoundness signal; must never happen (the battery counts it). */
  | { ok: false; reason: 'apply-failed'; details: { order: 'ab' | 'ba'; message: string } }
  /** Predicate said no conflict but the orders produced different bytes --
   *  the other unsoundness signal; must never happen. */
  | { ok: false; reason: 'non-commutative'; details: { note: string } };

export interface CommutationInput {
  base: ModelState;
  opsA: readonly MergeOp[];
  opsB: readonly MergeOp[];
  /** Default {@link DEFAULT_EPSILON_MM}. */
  epsilonMm?: number;
  clientA?: string;
  clientB?: string;
}

interface CrossAnalysis {
  fpsA: Footprint[];
  fpsB: Footprint[];
  conflicts: OpConflict[];
}

/** One structure-DAG build, both op sets footprinted, every cross pair (one
 *  op from A, one from B) run through `conflictPredicate`. Ops within a
 *  single client's set are sequenced by that client and never checked
 *  against each other. */
function analyzeCrossPairs(
  base: ModelState,
  opsA: readonly MergeOp[],
  opsB: readonly MergeOp[],
  epsilonMm: number,
): CrossAnalysis {
  const dag = buildStateDag(base);
  const fpsA = opsA.map((op) => computeMergeOpFootprint(dag, base, op));
  const fpsB = opsB.map((op) => computeMergeOpFootprint(dag, base, op));
  const conflicts: OpConflict[] = [];
  for (const fpA of fpsA) {
    for (const fpB of fpsB) {
      const result = conflictPredicate(fpA, fpB, { epsilonMm });
      if (result.conflict) conflicts.push({ aOpId: fpA.opId, bOpId: fpB.opId, result });
    }
  }
  return { fpsA, fpsB, conflicts };
}

/** Cross-pair conflict scan (see {@link analyzeCrossPairs}), conflicts only. */
export function findCrossConflicts(
  base: ModelState,
  opsA: readonly MergeOp[],
  opsB: readonly MergeOp[],
  epsilonMm: number = DEFAULT_EPSILON_MM,
): OpConflict[] {
  return analyzeCrossPairs(base, opsA, opsB, epsilonMm).conflicts;
}

export type ReplayOutcome =
  | { status: 'converged'; merged: ModelState }
  | { status: 'diverged' }
  | { status: 'apply-failed'; order: 'ab' | 'ba'; message: string };

/** Replay base+A+B and base+B+A; report convergence. This is the computable
 *  ground truth the battery scores false conflicts against. */
export function attemptBothOrders(
  base: ModelState,
  opsA: readonly MergeOp[],
  opsB: readonly MergeOp[],
): ReplayOutcome {
  let ab: ModelState;
  try {
    ab = applyOps(applyOps(base, opsA), opsB);
  } catch (err) {
    if (err instanceof OpApplicationError) return { status: 'apply-failed', order: 'ab', message: err.message };
    throw err;
  }
  let ba: ModelState;
  try {
    ba = applyOps(applyOps(base, opsB), opsA);
  } catch (err) {
    if (err instanceof OpApplicationError) return { status: 'apply-failed', order: 'ba', message: err.message };
    throw err;
  }
  if (canonicalStateBytes(ab) !== canonicalStateBytes(ba)) return { status: 'diverged' };
  return { status: 'converged', merged: ab };
}

function summarize(client: string, ops: readonly MergeOp[], fps: readonly Footprint[]): OpSetSummary {
  const written = new Set<string>();
  const regions: Aabb[] = [];
  for (const fp of fps) {
    for (const id of fp.writtenNodes) written.add(id);
    if (fp.region) regions.push(fp.region);
  }
  return {
    client,
    opIds: ops.map((op) => op.opId),
    writtenNodes: [...written].sort(),
    region: regions.length > 0 ? unionAabb(regions) : null,
  };
}

/**
 * Emit a commutation certificate for two concurrent op sets, or a typed
 * refusal. `ok: false, reason: 'conflict'` is the normal negative outcome;
 * `'apply-failed'` / `'non-commutative'` mean the conflict predicate
 * approved a pair that does NOT commute -- an unsound state of affairs this
 * function refuses to certify (and the property battery hunts for).
 */
export async function createCommutationCertificate(input: CommutationInput): Promise<CommutationOutcome> {
  const epsilonMm = input.epsilonMm ?? DEFAULT_EPSILON_MM;
  const { fpsA, fpsB, conflicts } = analyzeCrossPairs(input.base, input.opsA, input.opsB, epsilonMm);
  if (conflicts.length > 0) return { ok: false, reason: 'conflict', conflicts };

  const replay = attemptBothOrders(input.base, input.opsA, input.opsB);
  if (replay.status === 'apply-failed') {
    return { ok: false, reason: 'apply-failed', details: { order: replay.order, message: replay.message } };
  }
  if (replay.status === 'diverged') {
    return {
      ok: false,
      reason: 'non-commutative',
      details: { note: 'orders produced different canonical bytes despite a no-conflict verdict' },
    };
  }

  const [baseRootHash, mergedRootHash] = await Promise.all([
    hashModelState(input.base),
    hashModelState(replay.merged),
  ]);
  return {
    ok: true,
    merged: replay.merged,
    certificate: {
      version: COMMUTATION_CERTIFICATE_VERSION,
      model: 'merge-model-v0',
      epsilonMm,
      baseRootHash,
      mergedRootHash,
      a: summarize(input.clientA ?? 'client-a', input.opsA, fpsA),
      b: summarize(input.clientB ?? 'client-b', input.opsB, fpsB),
    },
  };
}

export interface CommutationVerificationOk {
  ok: true;
}

export interface CommutationVerificationFailure {
  ok: false;
  reason: string;
  details?: unknown;
}

export type CommutationVerificationResult = CommutationVerificationOk | CommutationVerificationFailure;

export interface CommutationVerifyOptions {
  /** Caller-owned identity for op set A. When supplied, `certificate.a.client`
   *  must match exactly. The client labels are attribution METADATA: nothing
   *  in the artifact cryptographically binds them (signing is out of scope
   *  for v0, spec decision Q5), so the only sound check is against an
   *  identity the VERIFIER already knows — deriving the expectation from the
   *  certificate's own field would let a tampered label verify. */
  expectedClientA?: string;
  /** Same for op set B / `certificate.b.client`. */
  expectedClientB?: string;
}

function fail(reason: string, details?: unknown): CommutationVerificationFailure {
  return { ok: false, reason, details };
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function sameRegion(a: Aabb | null, b: Aabb | null): boolean {
  if (a === null || b === null) return a === b;
  for (let i = 0; i < 3; i++) {
    if (a.min[i] !== b.min[i] || a.max[i] !== b.max[i]) return false;
  }
  return true;
}

function checkSummary(
  which: 'a' | 'b',
  summary: OpSetSummary,
  ops: readonly MergeOp[],
  fps: readonly Footprint[],
  expectedClient: string | undefined,
): CommutationVerificationFailure | undefined {
  // `client` is never fed back into `summarize` as its own expectation: that
  // would make the check a tautology. It is only checkable against a
  // caller-owned identity (see {@link CommutationVerifyOptions}).
  if (expectedClient !== undefined && summary.client !== expectedClient) {
    return fail('client-mismatch', { which, expected: expectedClient, actual: summary.client });
  }
  const expected = summarize(summary.client, ops, fps);
  if (!sameStringArray(summary.opIds, expected.opIds)) {
    return fail('op-ids-mismatch', { which, expected: expected.opIds, actual: summary.opIds });
  }
  if (!sameStringArray(summary.writtenNodes, expected.writtenNodes)) {
    return fail('written-nodes-mismatch', { which, expected: expected.writtenNodes, actual: summary.writtenNodes });
  }
  if (!sameRegion(summary.region, expected.region)) {
    return fail('region-mismatch', { which, expected: expected.region, actual: summary.region });
  }
  return undefined;
}

/**
 * Independently re-check a commutation certificate against the base state
 * and op sets it claims to cover. Recomputes footprints, the no-conflict
 * verdict (at the certificate's own epsilon), both replay orders, and both
 * Merkle commitments; any mismatch fails. Never throws for a verification
 * failure -- a failed verification is a normal return value (same contract
 * as certificate.ts).
 *
 * The `a.client`/`b.client` labels are attribution metadata: they are only
 * verified when the caller supplies its own expected identities via
 * `options` ({@link CommutationVerifyOptions}); without them the labels are
 * unverifiable and callers must not treat them as trusted.
 */
export async function verifyCommutationCertificate(
  certificate: CommutationCertificate,
  base: ModelState,
  opsA: readonly MergeOp[],
  opsB: readonly MergeOp[],
  options: CommutationVerifyOptions = {},
): Promise<CommutationVerificationResult> {
  if (certificate.version !== COMMUTATION_CERTIFICATE_VERSION) {
    return fail('version-mismatch', { expected: COMMUTATION_CERTIFICATE_VERSION, actual: certificate.version });
  }
  if (certificate.model !== 'merge-model-v0') {
    return fail('model-mismatch', { actual: certificate.model });
  }

  const { fpsA, fpsB, conflicts } = analyzeCrossPairs(base, opsA, opsB, certificate.epsilonMm);
  if (conflicts.length > 0) return fail('conflicting-op-sets', { conflicts });

  const summaryFailure =
    checkSummary('a', certificate.a, opsA, fpsA, options.expectedClientA) ??
    checkSummary('b', certificate.b, opsB, fpsB, options.expectedClientB);
  if (summaryFailure) return summaryFailure;

  const baseRootHash = await hashModelState(base);
  if (baseRootHash !== certificate.baseRootHash) {
    return fail('base-root-mismatch', { expected: certificate.baseRootHash, actual: baseRootHash });
  }

  const replay = attemptBothOrders(base, opsA, opsB);
  if (replay.status === 'apply-failed') {
    return fail('replay-apply-failed', { order: replay.order, message: replay.message });
  }
  if (replay.status === 'diverged') return fail('replay-diverged');

  const mergedRootHash = await hashModelState(replay.merged);
  if (mergedRootHash !== certificate.mergedRootHash) {
    return fail('merged-root-mismatch', { expected: certificate.mergedRootHash, actual: mergedRootHash });
  }
  return { ok: true };
}
