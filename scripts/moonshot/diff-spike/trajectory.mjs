/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * B3.3 proof-carrying optimization: trajectory certificates.
 *
 * Fuses the B2.4 differentiable spike with the M1 provenance machinery
 * (packages/provenance, node-hash-v0): every ACCEPTED optimization step is
 * committed as a small Merkle DAG (design parameters + derived quantities
 * -> state root hash via `computeNodeHash`) and chained to the previous
 * step through a step certificate. The chain is a verifiable artifact: an
 * independent verifier (verify-trajectory.mjs) re-derives every state,
 * every hash, every objective value and every acceptance decision from the
 * start parameters alone, without trusting the optimizer.
 *
 * State commitment (per chain position k):
 *   state/<k>/params      property-set "DesignParameters"  (24 exact f64s)
 *   state/<k>/quantities  property-set "DerivedQuantities" (carbon, volumes,
 *                         max constraint violation under the chain scenario)
 *   state/<k>/root        element node binding both psets -> the state ROOT
 *
 * Numbers are committed as exact f64 bit patterns (node-hash-v0 hashes the
 * 8 LE bytes of the double), so a state root pins the design to the bit.
 *
 * Step certificates are REAL `@ifc-lite/provenance` v0 certificates
 * (createCertificate/verifyCertificate) - reads = previous state's nodes,
 * writes = new state's nodes, claims = a scalar-delta on EmbodiedCarbon -
 * wrapped in a chain record that adds the optimizer-specific facts
 * (parameterDelta, merit before/after, gradient norm, step size,
 * backtrack count) the verifier replays.
 */

import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setDim, value } from './dual.mjs';
import { PARAMS, NPARAMS, evaluateNumeric } from './carbon-model.mjs';
import { REPO_ROOT } from './build-ifc.mjs';

const { computeNodeHash, createCertificate } = await import(
  path.join(REPO_ROOT, 'packages/provenance/dist/index.js')
);

export const CHAIN_VERSION = 'trajectory-cert-v0';

export function sha256hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Canonical form of an @ifc-lite/create STEP file for hash commitment.
 *
 * IfcCreator output is deterministic in everything derived from the design
 * vector, but carries three run-local artifacts a rebuild cannot reproduce:
 * random 22-char GlobalIds (crypto.randomUUID), the FILE_NAME header
 * timestamp, and the IfcOwnerHistory unix timestamp. Canonicalization
 * replaces exactly those three (verified: two same-x builds differ ONLY on
 * these) so `sha256(canonicalIfc(content))` commits every quantity-bearing
 * byte - geometry, placements, materials, relationships, names - while a
 * verifier can re-derive it from the parameters alone. The RAW file hash is
 * additionally recorded as the on-disk artifact id, but it is a label, not
 * a re-derivable commitment.
 */
export function canonicalIfc(content) {
  return content
    .replace(/^(FILE_NAME\('created\.ifc'),'\d{8}T\d{6}'/m, "$1,'00000000T000000'")
    .replace(/^(#\d+=IFCOWNERHISTORY\(.*),\d+\);$/m, '$1,0);')
    .replace(/^(#\d+=[A-Z0-9]+\()'[0-9A-Za-z_$]{22}'/gm, "$1'0000000000000000000000'");
}

/**
 * Kernel identity pins for the certificates (spec section 4 semantics):
 * `kernelVersion` names the geometry-kernel build by package versions;
 * `trustRoot` is the SHA-256 of the actual wasm binary every kernel check
 * in this chain ran through. A verifier on a different kernel build fails
 * fast instead of comparing incomparable numbers.
 */
export function getKernelIdentity() {
  const wasmPkg = JSON.parse(
    readFileSync(path.join(REPO_ROOT, 'packages/wasm/package.json'), 'utf8'));
  const geomPkg = JSON.parse(
    readFileSync(path.join(REPO_ROOT, 'packages/geometry/package.json'), 'utf8'));
  const wasmBytes = readFileSync(path.join(REPO_ROOT, 'packages/wasm/pkg/ifc-lite_bg.wasm'));
  return {
    kernelVersion: `@ifc-lite/wasm@${wasmPkg.version}+@ifc-lite/geometry@${geomPkg.version}`,
    trustRoot: `sha256:${sha256hex(wasmBytes)}`,
  };
}

/** Node ids for chain position k. */
export function nodeIds(k) {
  return {
    params: `state/${k}/params`,
    quantities: `state/${k}/quantities`,
    root: `state/${k}/root`,
  };
}

/**
 * Build the two leaf property-set payloads for a design vector under a
 * scenario. Pure re-derivation: everything comes from `evaluateNumeric`
 * (the battery-validated closed forms), nothing from the optimizer.
 */
export function statePayloads(x, scenario) {
  setDim(0); // numeric-only evaluation; meritDual re-arms the dual dim itself
  const n = evaluateNumeric(x, scenario);
  const maxViolation = Math.max(0, ...n.constraints.map((c) => c.g));
  const params = {
    name: 'DesignParameters',
    properties: PARAMS.map((p, i) => ({ name: p.name, value: x[i] })),
  };
  const qprops = [
    { name: 'EmbodiedCarbon', value: n.carbon },
    { name: 'TotalVolume', value: n.totalVolume },
    { name: 'MaxConstraintViolation', value: maxViolation },
  ];
  for (const [mat, vol] of Object.entries(n.model.byMaterial)) {
    qprops.push({ name: `Volume_${mat}`, value: value(vol) });
  }
  const quantities = { name: 'DerivedQuantities', properties: qprops };
  return { params, quantities, numeric: n, maxViolation };
}

export function rootPayload(paramsHash, qHash) {
  return {
    key: 'diff-spike-design',
    ifcType: 'ParametricBuilding',
    components: [
      { componentKey: 'pset:DesignParameters', hash: paramsHash },
      { componentKey: 'pset:DerivedQuantities', hash: qHash },
    ],
  };
}

/**
 * Commit one design state: hash params pset, quantities pset, and the
 * element root binding them. Returns the hashes plus the payloads (so a
 * verifier can seed a NodeResolver with its OWN re-derivation).
 */
export async function commitState(x, scenario) {
  const { params, quantities, numeric, maxViolation } = statePayloads(x, scenario);
  const paramsHash = await computeNodeHash('property-set', params);
  const qHash = await computeNodeHash('property-set', quantities);
  const root = await computeNodeHash('element', rootPayload(paramsHash, qHash));
  return { params, quantities, paramsHash, qHash, root, numeric, maxViolation };
}

export function stateRefs(k, committed) {
  const ids = nodeIds(k);
  return [
    { nodeId: ids.params, hash: committed.paramsHash },
    { nodeId: ids.quantities, hash: committed.qHash },
    { nodeId: ids.root, hash: committed.root },
  ];
}

/**
 * Build the certificate chain from a recorded optimization trajectory.
 *
 * @param {object} input
 * @param {string} input.scenarioName
 * @param {object} input.scenario   constraint scenario (chain-committed)
 * @param {number[]} input.startX   start parameters (chain position 0)
 * @param {Array}  input.events     interleaved {type:'step',...}/{type:'mu-ramp',...}
 *                                  exactly as optimize()'s callbacks emitted them
 * @param {object} input.optimizer  {startMu, muFactor, stepInit, armijoC, btMax}
 * @param {object} [input.kernelIdentity]
 */
export async function buildChain({ scenarioName, scenario, startX, events, optimizer, kernelIdentity }) {
  const { kernelVersion, trustRoot } = kernelIdentity ?? getKernelIdentity();
  let k = 0;
  let cur = await commitState(startX, scenario);
  let curX = startX.slice();
  const startRoot = cur.root;
  const records = [];

  for (const ev of events) {
    if (ev.type === 'step') {
      // Sanity: the recorded step must depart from the state we are at.
      for (let i = 0; i < NPARAMS; i++) {
        if (ev.prevX[i] !== curX[i]) {
          throw new Error(`trajectory discontinuity at step ${k + 1}, param ${PARAMS[i].name}`);
        }
      }
      k += 1;
      const next = await commitState(ev.newX, scenario);
      const certificate = createCertificate({
        kernelVersion,
        trustRoot,
        reads: stateRefs(k - 1, cur),
        writes: stateRefs(k, next),
        claims: [{
          type: 'scalar-delta',
          metric: 'property-numeric',
          property: 'EmbodiedCarbon',
          before: ev.carbonBefore,
          after: ev.carbonAfter,
          delta: ev.carbonAfter - ev.carbonBefore,
          beforeNodeId: nodeIds(k - 1).quantities,
          afterNodeId: nodeIds(k).quantities,
        }],
      });
      records.push({
        index: k,
        kind: 'step',
        mu: ev.mu,
        prevRoot: cur.root,
        newRoot: next.root,
        newParams: ev.newX,
        parameterDelta: ev.newX.map((v, i) => v - curX[i]),
        carbonBefore: ev.carbonBefore,
        carbonAfter: ev.carbonAfter,
        meritBefore: ev.meritBefore,
        meritAfter: ev.meritAfter,
        gradientNormBefore: ev.gradientNormBefore,
        stepSize: ev.stepSize,
        backtracks: ev.backtracks,
        certificate,
      });
      cur = next;
      curX = ev.newX.slice();
    } else if (ev.type === 'mu-ramp') {
      for (let i = 0; i < NPARAMS; i++) {
        if (ev.x[i] !== curX[i]) {
          throw new Error(`mu-ramp state mismatch after step ${k}`);
        }
      }
      records.push({
        index: k,
        kind: 'mu-ramp',
        muBefore: ev.muBefore,
        muAfter: ev.muAfter,
        root: cur.root,
      });
    } else {
      throw new Error(`unknown trajectory event type: ${ev.type}`);
    }
  }

  return {
    version: CHAIN_VERSION,
    scenarioName,
    scenario,
    optimizer,
    kernelVersion,
    trustRoot,
    startParams: startX,
    startRoot,
    steps: k,
    records,
    endpoint: null,
    finalState: { index: k, root: cur.root, carbon: cur.numeric.carbon, maxViolation: cur.maxViolation },
  };
}

/** The endpoint kernel-validation property-set payload (exact recorded values). */
export function endpointKernelPayload(endpoint) {
  return {
    name: 'KernelValidation',
    properties: [
      { name: 'KernelCarbon', value: endpoint.kernel.carbon },
      { name: 'WorstElementRelDev', value: endpoint.kernel.worstRelDev },
      { name: 'MissingMeshes', value: endpoint.kernel.missingMeshes },
      { name: 'MeshedElements', value: endpoint.kernel.meshedElements },
      { name: 'IfcCanonicalSha256', value: endpoint.ifcCanonicalSha256 },
      { name: 'IfcSha256', value: endpoint.ifcSha256 },
      { name: 'IfcBytes', value: endpoint.ifcBytes },
      { name: 'ValidateErrors', value: endpoint.validate.errors },
      { name: 'ValidateIssues', value: endpoint.validate.issues },
      { name: 'ClashRealHard', value: endpoint.clash.real },
      { name: 'ClashContacts', value: endpoint.clash.contacts },
      { name: 'ClashWorstDepth', value: endpoint.clash.worstDepth },
    ],
  };
}

export function endpointRootPayload(stateRoot, kernelHash) {
  return {
    key: 'diff-spike-endpoint',
    ifcType: 'ParametricBuildingEndpoint',
    components: [
      { componentKey: 'state-root', hash: stateRoot },
      { componentKey: 'pset:KernelValidation', hash: kernelHash },
    ],
  };
}

/**
 * Terminate the chain in a kernel-validated, hash-committed artifact:
 * bind the endpointChecks() results (kernel-measured quantities, validate
 * and clash outcomes, the IFC file's SHA-256) into a final certificate
 * whose root commits BOTH the final design state and the kernel numbers.
 *
 * @param {object} chain   output of buildChain (mutated: .endpoint is set)
 * @param {number[]} finalX
 * @param {object} ep      result of optimize.mjs endpointChecks()
 */
export async function attachEndpoint(chain, finalX, ep) {
  // Refuse to certify an endpoint whose kernel outcome was not fully
  // measured or not acceptable: -1 sentinels (unparsed validate/clash),
  // non-finite depths, validation errors, or real clashes must never end
  // up under a certificate that claims a verified endpoint.
  if (!ep.validate?.parsed || !ep.clash?.parsed) {
    throw new Error('attachEndpoint: validate/clash output was not parsed -- endpoint is unmeasured, refusing to certify');
  }
  if (!Number.isFinite(ep.clash.worstDepth) || ep.validate.errors < 0 || ep.clash.real < 0) {
    throw new Error('attachEndpoint: endpoint carries sentinel/non-finite measurements, refusing to certify');
  }
  if (ep.validate.errors > 0 || ep.clash.real > 0) {
    throw new Error(`attachEndpoint: endpoint fails kernel acceptance (validateErrors=${ep.validate.errors}, realClashes=${ep.clash.real}), refusing to certify`);
  }
  const k = chain.steps;
  const finalState = await commitState(finalX, chain.scenario);
  if (finalState.root !== chain.finalState.root) {
    throw new Error('attachEndpoint: finalX does not match the chain final state');
  }
  const endpoint = {
    kind: 'endpoint',
    stateIndex: k,
    stateRoot: finalState.root,
    ifcCanonicalSha256: `sha256:${sha256hex(canonicalIfc(ep.content))}`,
    ifcSha256: `sha256:${sha256hex(ep.content)}`,
    ifcBytes: ep.content.length,
    kernel: {
      carbon: ep.kernel.carbon,
      worstRelDev: ep.kernel.worstRelDev,
      missingMeshes: ep.kernel.missingMeshes,
      meshedElements: ep.kernel.meshedElements,
    },
    validate: { errors: ep.validate.errors, issues: ep.validate.issues },
    clash: { real: ep.clash.real, contacts: ep.clash.contacts, worstDepth: ep.clash.worstDepth },
  };
  const kernelHash = await computeNodeHash('property-set', endpointKernelPayload(endpoint));
  const endpointRoot = await computeNodeHash(
    'element', endpointRootPayload(finalState.root, kernelHash));
  endpoint.kernelHash = kernelHash;
  endpoint.endpointRoot = endpointRoot;
  endpoint.certificate = createCertificate({
    kernelVersion: chain.kernelVersion,
    trustRoot: chain.trustRoot,
    reads: stateRefs(k, finalState),
    writes: [
      { nodeId: 'endpoint/kernel', hash: kernelHash },
      { nodeId: 'endpoint/root', hash: endpointRoot },
    ],
    // The endpoint writes must not disturb the final design state.
    claims: [{ type: 'subtree-untouched', nodes: stateRefs(k, finalState) }],
  });
  chain.endpoint = endpoint;
  return endpoint;
}

/* ------------------------------------------------------------------ */
/* Chain format v2: checkpointed segments (DESIGN.md section 8)         */
/* ------------------------------------------------------------------ */

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

/**
 * Build the NodeResolver a verifier hands to verifyCertificate for a step
 * k-1 -> k: every node id resolves to a payload RE-DERIVED by the verifier
 * (from its own recomputation), never to anything the chain claims.
 */
export function makeStateResolver(entries) {
  const map = new Map();
  for (const { k, committed } of entries) {
    const ids = nodeIds(k);
    map.set(ids.params, { kind: 'property-set', payload: committed.params });
    map.set(ids.quantities, { kind: 'property-set', payload: committed.quantities });
    map.set(ids.root, {
      kind: 'element',
      payload: rootPayload(committed.paramsHash, committed.qHash),
    });
  }
  return async (nodeId) => map.get(nodeId);
}
