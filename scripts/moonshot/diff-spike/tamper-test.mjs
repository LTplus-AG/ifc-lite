/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * B3.3 proof-carrying optimization: tamper detection test.
 *
 * Loads a real certificate chain, then verifies that (a) the untampered
 * chain passes and (b) a battery of adversarial mutations - each applied
 * to a fresh copy, mid-chain where possible - is DETECTED by
 * verify-trajectory.mjs with a sensible machine-readable reason:
 *
 *   flip-parameter     a mid-chain design parameter is nudged (with the
 *                      parameter delta kept consistent, as a lazy forger
 *                      would) -> the projected-gradient replay cannot
 *                      reproduce the recorded iterate
 *   fake-objective     the recorded post-step carbon is lowered (and the
 *                      step certificate's scalar-delta claim adjusted to
 *                      match) -> re-derived objective disagrees
 *   break-linkage      a mid-chain prevRoot is swapped -> Merkle chain
 *                      linkage broken
 *   forge-root         a mid-chain newRoot is replaced -> recommitted
 *                      state root disagrees
 *   tamper-endpoint    the bound kernel carbon is changed -> the endpoint
 *                      property-set hash no longer matches
 *   consistent-endpoint (--full only) the bound kernel carbon is changed
 *                      AND all downstream hashes + the endpoint
 *                      certificate are honestly recomputed - only the
 *                      kernel RE-MEASUREMENT catches it
 *
 * Usage: node scripts/moonshot/diff-spike/tamper-test.mjs CHAIN.json [--full]
 */

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { verifyChain } from './verify-trajectory.mjs';
import { endpointKernelPayload, endpointRootPayload } from './trajectory.mjs';
import { REPO_ROOT } from './build-ifc.mjs';

const { computeNodeHash, createCertificate } = await import(
  path.join(REPO_ROOT, 'packages/provenance/dist/index.js')
);

function midStepIndex(chain) {
  const stepPositions = chain.records
    .map((r, i) => (r.kind === 'step' ? i : -1))
    .filter((i) => i >= 0);
  return stepPositions[Math.floor(stepPositions.length / 2)];
}

/** Each tamper mutates a structuredClone of the chain and names the
 *  failure reasons it would accept as detection. */
const TAMPERS = [
  {
    name: 'flip-parameter',
    expect: ['step-not-reproducible', 'armijo-violation', 'line-search-replay-divergence'],
    apply(chain) {
      const i = midStepIndex(chain);
      const rec = chain.records[i];
      const j = 5; // exterior wall thickness
      const prev = i === 0 ? chain.startParams : findPrevParams(chain, i);
      rec.newParams[j] += 0.001;
      rec.parameterDelta[j] = rec.newParams[j] - prev[j]; // lazy-forger consistency
      return `step ${rec.index}: newParams[tw] += 1 mm (delta kept consistent)`;
    },
  },
  {
    name: 'fake-objective',
    expect: ['objective-after-mismatch'],
    apply(chain) {
      const i = midStepIndex(chain);
      const rec = chain.records[i];
      rec.carbonAfter -= 500;
      const claim = rec.certificate.claims.find((c) => c.type === 'scalar-delta');
      claim.after = rec.carbonAfter;
      claim.delta = claim.after - claim.before;
      return `step ${rec.index}: carbonAfter -= 500 kgCO2e (certificate claim adjusted to match)`;
    },
  },
  {
    name: 'break-linkage',
    expect: ['chain-linkage-broken'],
    apply(chain) {
      const i = midStepIndex(chain);
      const rec = chain.records[i];
      rec.prevRoot = chain.startRoot; // a real hash, just the wrong one
      return `step ${rec.index}: prevRoot replaced with the chain start root`;
    },
  },
  {
    name: 'forge-root',
    expect: ['state-root-mismatch'],
    apply(chain) {
      const i = midStepIndex(chain);
      const rec = chain.records[i];
      rec.newRoot = chain.finalState.root; // a real hash, just the wrong one
      return `step ${rec.index}: newRoot replaced with the final state root`;
    },
  },
  {
    name: 'tamper-endpoint',
    expect: ['kernel-pset-hash-mismatch'],
    apply(chain) {
      chain.endpoint.kernel.carbon -= 1000;
      return 'endpoint: bound kernel carbon -= 1000 kgCO2e (hashes left as-is)';
    },
  },
];

function findPrevParams(chain, recIdx) {
  for (let i = recIdx - 1; i >= 0; i--) {
    if (chain.records[i].kind === 'step') return chain.records[i].newParams;
  }
  return chain.startParams;
}

/** The hard case: fake the kernel numbers and recompute every hash and the
 *  endpoint certificate honestly. Only re-measurement can catch this. */
async function consistentEndpointTamper(chain) {
  const ep = chain.endpoint;
  ep.kernel.carbon -= 1000;
  ep.kernelHash = await computeNodeHash('property-set', endpointKernelPayload(ep));
  ep.endpointRoot = await computeNodeHash(
    'element', endpointRootPayload(ep.stateRoot, ep.kernelHash));
  ep.certificate = createCertificate({
    kernelVersion: chain.kernelVersion,
    trustRoot: chain.trustRoot,
    reads: ep.certificate.reads,
    writes: [
      { nodeId: 'endpoint/kernel', hash: ep.kernelHash },
      { nodeId: 'endpoint/root', hash: ep.endpointRoot },
    ],
    claims: ep.certificate.claims,
  });
  return 'endpoint: kernel carbon -= 1000 kgCO2e with ALL hashes + certificate recomputed consistently';
}

async function main() {
  const argv = process.argv.slice(2);
  const chainPath = argv.find((a) => !a.startsWith('-'));
  const full = argv.includes('--full');
  if (!chainPath) {
    console.error('usage: node tamper-test.mjs CHAIN.json [--full]');
    process.exit(2);
  }
  const original = JSON.parse(readFileSync(chainPath, 'utf8'));
  let failures = 0;

  // Control: the untampered chain must verify (fast mode: endpoint hashes
  // and certificates checked, kernel re-measurement exercised separately by
  // verify-trajectory.mjs runs and the --full case below).
  const t0 = performance.now();
  const control = await verifyChain(structuredClone(original), { skipKernel: true });
  const controlMs = performance.now() - t0;
  if (control.ok) {
    console.log(`control: untampered chain VERIFIED (${control.stats.steps} steps, ${(controlMs / 1000).toFixed(1)}s)`);
  } else {
    failures += 1;
    console.error('control: untampered chain FAILED verification:', JSON.stringify(control.failure));
  }

  for (const tamper of TAMPERS) {
    const chain = structuredClone(original);
    const desc = tamper.apply(chain);
    const res = await verifyChain(chain, { skipKernel: true });
    if (res.ok) {
      failures += 1;
      console.error(`${tamper.name}: NOT DETECTED (${desc})`);
    } else if (!tamper.expect.includes(res.failure.reason)) {
      failures += 1;
      console.error(`${tamper.name}: detected but with unexpected reason ` +
        `"${res.failure.reason}" at ${res.failure.where} (${desc}; expected one of ${tamper.expect.join('|')})`);
    } else {
      console.log(`${tamper.name}: DETECTED as "${res.failure.reason}" at ${res.failure.where}`);
      console.log(`  (${desc})`);
    }
  }

  if (full) {
    const chain = structuredClone(original);
    const desc = await consistentEndpointTamper(chain);
    const res = await verifyChain(chain, { skipKernel: false, chainPath });
    if (res.ok) {
      failures += 1;
      console.error(`consistent-endpoint: NOT DETECTED (${desc})`);
    } else if (res.failure.reason !== 'kernel-carbon-mismatch') {
      failures += 1;
      console.error(`consistent-endpoint: detected but with unexpected reason "${res.failure.reason}" (${desc})`);
    } else {
      console.log(`consistent-endpoint: DETECTED as "kernel-carbon-mismatch" by re-measurement`);
      console.log(`  (${desc})`);
    }
  }

  console.log('---');
  if (failures === 0) {
    console.log(`tamper test PASS: control verified, ${TAMPERS.length + (full ? 1 : 0)} tampers detected`);
    process.exit(0);
  }
  console.error(`tamper test FAIL: ${failures} problem(s)`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
