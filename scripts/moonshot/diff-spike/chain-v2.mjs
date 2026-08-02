/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * B3.3 proof-carrying optimization: chain format v2 (checkpointed
 * segments) - the BUILDER side. Format, modes and measured tradeoffs:
 * DESIGN.md section 8, "Chain format v2".
 *
 * v1 (trajectory.mjs) emits one provenance certificate per accepted step,
 * which is correct but produces 22k+ records and tens of MB per run. v2
 * batches N consecutive steps into a segment whose certificate commits the
 * segment's start/end state DAG roots and an aggregate EmbodiedCarbon
 * claim, while the segment record carries a Merkle root over the per-step
 * commitment hashes. Per-step data collapses to a JSONL sidecar carrying
 * one field per step (the backtrack count); everything else is
 * re-derivable, so the sidecar is a replay AID, never a data channel.
 *
 * The provenance wire format is untouched: segment certificates are
 * ordinary `@ifc-lite/provenance` v0 certificates built with the frozen
 * primitives.
 */

import path from 'node:path';
import { REPO_ROOT } from './build-ifc.mjs';
import {
  CHAIN_VERSION, commitState, nodeIds, sha256hex, stateRefs,
} from './trajectory.mjs';

const { createCertificate } = await import(
  path.join(REPO_ROOT, 'packages/provenance/dist/index.js')
);

export const CHAIN_VERSION_V2 = 'trajectory-cert-v2';
export const STEP_COMMIT_VERSION = 'step-commit-v2';
export const DEFAULT_SEGMENT_SIZE = 256;

/**
 * Per-step commitment hash for chain v2. Every field is DERIVED (by the
 * builder from the recorded trajectory, by a verifier from its own replay);
 * the hash is a commitment, not a data channel. Key order is fixed here -
 * both sides call this one function, so JSON.stringify is canonical enough
 * (ECMA number-to-string is the deterministic shortest round-trip form).
 */
export function stepCommitHash({
  k, mu, prevRoot, newRoot, newParams, backtracks, stepSize,
  carbonBefore, carbonAfter, meritBefore, meritAfter, gradientNormBefore,
}) {
  return sha256hex(JSON.stringify({
    v: STEP_COMMIT_VERSION, k, mu, prevRoot, newRoot, newParams, backtracks,
    stepSize, carbonBefore, carbonAfter, meritBefore, meritAfter, gradientNormBefore,
  }));
}

/**
 * Merkle root over an ordered list of hex hashes: pairwise SHA-256 of the
 * concatenated hex strings, an odd last node is carried up unchanged.
 */
export function merkleRoot(hashes) {
  if (hashes.length === 0) return sha256hex('merkle-empty-v2');
  let level = hashes;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? sha256hex(level[i] + level[i + 1]) : level[i]);
    }
    level = next;
  }
  return level[0];
}

/** One sidecar line per v1 chain record: steps keep only the line-search
 *  outcome (everything else is re-derivable), ramps keep the mu pair. */
export function sidecarLine(rec) {
  if (rec.kind === 'step') return JSON.stringify({ b: rec.backtracks });
  if (rec.kind === 'mu-ramp') return JSON.stringify({ mu: [rec.muBefore, rec.muAfter] });
  throw new Error(`sidecarLine: unknown record kind "${rec.kind}"`);
}

/**
 * Convert a v1 chain (buildChain output, endpoint attached or not) into the
 * checkpointed v2 format: consecutive steps are batched into segments of up
 * to `segmentSize` steps. Each segment certificate commits
 *   (a) the segment's start and end state DAG roots (reads/writes),
 *   (b) via the segment record, a Merkle root over the per-step commitment
 *       hashes inside the segment,
 *   (c) the aggregate claim (EmbodiedCarbon start -> end, step count).
 * Per-step data (backtrack counts, mu ramps) moves to a JSONL sidecar whose
 * SHA-256 is pinned in the v2 header. mu ramps stay attached to the segment
 * whose last step precedes them.
 */
export async function chainToV2(chain, { segmentSize = DEFAULT_SEGMENT_SIZE, sidecarFile = 'trajectory-steps-v2.jsonl' } = {}) {
  if (chain.version !== CHAIN_VERSION) {
    throw new Error(`chainToV2: expected a ${CHAIN_VERSION} chain, got "${chain.version}"`);
  }
  if (!Number.isInteger(segmentSize) || segmentSize < 1) {
    throw new Error(`chainToV2: segmentSize must be a positive integer, got ${segmentSize}`);
  }
  const { kernelVersion, trustRoot, scenario } = chain;
  const lines = [];
  const segments = [];

  let mu = chain.optimizer.startMu;
  let k = 0;
  let segStart = null; // state at the open segment's entry
  let stepCommits = [];
  let lastStep = null;

  const startCommitted = await commitState(chain.startParams, scenario);
  if (startCommitted.root !== chain.startRoot) {
    throw new Error('chainToV2: recommitted start root does not match the chain');
  }
  const openSegment = (committed, x, recordStart) => {
    segStart = {
      stepStart: k,
      recordStart,
      muStart: mu,
      committed,
      x,
      carbonStart: committed.numeric.carbon,
    };
    stepCommits = [];
    lastStep = null;
  };
  const closeSegment = async (recordEnd) => {
    const endCommitted = await commitState(lastStep.newParams, scenario);
    if (endCommitted.root !== lastStep.newRoot) {
      throw new Error(`chainToV2: recommitted root diverges at step ${k}`);
    }
    if (endCommitted.numeric.carbon !== lastStep.carbonAfter) {
      throw new Error(`chainToV2: recommitted carbon diverges at step ${k}`);
    }
    const certificate = createCertificate({
      kernelVersion,
      trustRoot,
      reads: stateRefs(segStart.stepStart, segStart.committed),
      writes: stateRefs(k, endCommitted),
      claims: [{
        type: 'scalar-delta',
        metric: 'property-numeric',
        property: 'EmbodiedCarbon',
        before: segStart.carbonStart,
        after: lastStep.carbonAfter,
        delta: lastStep.carbonAfter - segStart.carbonStart,
        beforeNodeId: nodeIds(segStart.stepStart).quantities,
        afterNodeId: nodeIds(k).quantities,
      }],
    });
    segments.push({
      index: segments.length,
      stepStart: segStart.stepStart,
      stepEnd: k,
      recordStart: segStart.recordStart,
      recordEnd,
      muStart: segStart.muStart,
      muEnd: mu,
      startRoot: segStart.committed.root,
      endRoot: endCommitted.root,
      endParams: lastStep.newParams,
      carbonStart: segStart.carbonStart,
      carbonEnd: lastStep.carbonAfter,
      stepsRoot: `sha256:${merkleRoot(stepCommits)}`,
      certificate,
    });
    openSegment(endCommitted, lastStep.newParams, recordEnd);
  };

  openSegment(startCommitted, chain.startParams, 0);
  for (const rec of chain.records) {
    if (rec.kind === 'step') {
      if (stepCommits.length >= segmentSize) await closeSegment(lines.length);
      k += 1;
      if (rec.index !== k) throw new Error(`chainToV2: step index gap at ${k}`);
      stepCommits.push(stepCommitHash({
        k,
        mu: rec.mu,
        prevRoot: rec.prevRoot,
        newRoot: rec.newRoot,
        newParams: rec.newParams,
        backtracks: rec.backtracks,
        stepSize: rec.stepSize,
        carbonBefore: rec.carbonBefore,
        carbonAfter: rec.carbonAfter,
        meritBefore: rec.meritBefore,
        meritAfter: rec.meritAfter,
        gradientNormBefore: rec.gradientNormBefore,
      }));
      lastStep = rec;
    } else if (rec.kind === 'mu-ramp') {
      mu = rec.muAfter;
    } else {
      throw new Error(`chainToV2: unknown record kind "${rec.kind}"`);
    }
    lines.push(sidecarLine(rec));
  }
  if (stepCommits.length > 0) {
    await closeSegment(lines.length);
  } else if (segments.length > 0 && lines.length > segments[segments.length - 1].recordEnd) {
    // Trailing mu ramps with no step after them (a penalty round can accept
    // zero steps): attach them to the last segment - they do not change the
    // state, only the mu the (nonexistent) next step would have seen.
    const last = segments[segments.length - 1];
    last.recordEnd = lines.length;
    last.muEnd = mu;
  }
  if (segments.length === 0) throw new Error('chainToV2: chain has no steps');
  if (k !== chain.steps) {
    throw new Error(`chainToV2: counted ${k} steps, chain header says ${chain.steps}`);
  }

  const sidecarText = lines.join('\n') + '\n';
  const chainV2 = {
    version: CHAIN_VERSION_V2,
    scenarioName: chain.scenarioName,
    scenario,
    optimizer: chain.optimizer,
    kernelVersion,
    trustRoot,
    startParams: chain.startParams,
    startRoot: chain.startRoot,
    steps: chain.steps,
    segmentSize,
    sidecar: {
      file: sidecarFile,
      sha256: `sha256:${sha256hex(sidecarText)}`,
      records: lines.length,
    },
    segments,
    endpoint: chain.endpoint,
    finalState: chain.finalState,
  };
  return { chainV2, sidecarText };
}
