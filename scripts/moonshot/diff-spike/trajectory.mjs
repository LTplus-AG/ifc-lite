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
 * Canonical form of an @ifc-lite/create STEP file for hash commitment -
 * the FALLBACK path for uncontrolled creators.
 *
 * A default (unseeded) IfcCreator build carries three run-local artifacts a
 * rebuild cannot reproduce: random 22-char GlobalIds (crypto.randomUUID),
 * the FILE_NAME header timestamp, and the IfcOwnerHistory unix timestamp.
 * Canonicalization replaces exactly those three (verified: two same-x
 * builds differ ONLY on these) so `sha256(canonicalIfc(content))` commits
 * every quantity-bearing byte - geometry, placements, materials,
 * relationships, names - while a verifier can re-derive it from the
 * parameters alone.
 *
 * Certified runs no longer need the fallback: they build with
 * `seededBuildOptions` (build-ifc.mjs) so the RAW file bytes are a pure
 * function of the final parameters plus the `ifcBuild` descriptor bound in
 * the endpoint certificate, and the verifier checks the RAW sha256 too.
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

/**
 * The endpoint kernel-validation property-set payload (exact recorded
 * values). Seeded builds additionally commit the `ifcBuild` descriptor -
 * the recipe that makes the RAW `IfcSha256` re-derivable; the fields are
 * appended conditionally so chains from unseeded (fallback) builds keep
 * hashing exactly as before.
 */
export function endpointKernelPayload(endpoint) {
  const properties = [
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
  ];
  if (endpoint.ifcBuild) {
    properties.push(
      { name: 'IfcBuildMode', value: endpoint.ifcBuild.mode },
      { name: 'IfcBuildSpec', value: endpoint.ifcBuild.spec },
      { name: 'IfcBuildGuidSeed', value: endpoint.ifcBuild.guidSeed },
      { name: 'IfcBuildTimestampMs', value: endpoint.ifcBuild.timestampMs },
    );
  }
  return { name: 'KernelValidation', properties };
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
  // Only null/undefined mean "absent". A falsy-but-present value (false, 0,
  // '') must not slip past the guard via short-circuit and then be stored by
  // `?? null` as if it were a descriptor.
  if (ep.ifcBuild != null && (typeof ep.ifcBuild !== 'object'
    || ep.ifcBuild.mode !== 'seeded'
    || typeof ep.ifcBuild.spec !== 'string'
    || typeof ep.ifcBuild.guidSeed !== 'string'
    || !Number.isFinite(ep.ifcBuild.timestampMs))) {
    throw new Error('attachEndpoint: malformed ifcBuild descriptor - refusing to certify an unre-derivable raw-hash claim');
  }
  const endpoint = {
    kind: 'endpoint',
    stateIndex: k,
    stateRoot: finalState.root,
    // Seeded builds: the raw IfcSha256 is re-derivable from finalX +
    // ifcBuild; the canonical hash stays as the creator-agnostic fallback.
    ifcBuild: ep.ifcBuild ?? null,
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
