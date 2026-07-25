/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * B3.3 proof-carrying optimization: the certified run.
 *
 * Runs the B2.4 optimizer (optimize.mjs, unchanged mathematics) while
 * recording every accepted step, then materializes the trajectory as a
 * certificate chain (trajectory.mjs):
 *
 *   1. every accepted iterate is hash-committed (params + derived
 *      quantities -> node-hash-v0 state root) and chained to its
 *      predecessor via a provenance step certificate,
 *   2. at the optimum the real IFC is built, the kernel checks run
 *      (meshing + quantity comparison, ifc-lite validate, ifc-lite clash),
 *      and the kernel-measured numbers are bound into a final endpoint
 *      certificate, so the chain terminates in a kernel-validated,
 *      hash-committed artifact.
 *
 * The chain is written as JSON next to the optimum IFC. Verify it
 * independently with verify-trajectory.mjs (which re-derives everything
 * from the start parameters without trusting this script).
 *
 * Usage:
 *   node scripts/moonshot/diff-spike/optimize-certified.mjs \
 *     [--scenario baseline|strict] [--out DIR] [--rounds N] [--max-iter M]
 *
 * `--rounds` / `--max-iter` shrink the optimizer budget for a short smoke
 * run; the chain stays fully verifiable (the verifier replays recorded
 * events, however many there are).
 */

import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { PARAMS, NPARAMS, evaluateNumeric } from './carbon-model.mjs';
import { optimize, endpointChecks, SCENARIOS, G_SCALE } from './optimize.mjs';
import { buildChain, attachEndpoint, getKernelIdentity } from './trajectory.mjs';
import { SEEDED_BUILD_SPEC } from './build-ifc.mjs';

async function main() {
  const argv = process.argv.slice(2);
  const scenIdx = argv.indexOf('--scenario');
  const scenarioName = scenIdx >= 0 ? argv[scenIdx + 1] : 'baseline';
  const scenario = SCENARIOS[scenarioName];
  if (!scenario) {
    console.error(`unknown scenario "${scenarioName}" (have: ${Object.keys(SCENARIOS).join(', ')})`);
    process.exit(2);
  }
  const outIdx = argv.indexOf('--out');
  const outValue = outIdx >= 0 ? argv[outIdx + 1] : undefined;
  // A bare trailing `--out` must fall back to the default, not mkdir(undefined).
  const outDir = outValue !== undefined && !outValue.startsWith('--')
    ? outValue
    : path.join(tmpdir(), 'ifc-lite-diff-spike-certified', scenarioName);
  mkdirSync(outDir, { recursive: true });

  console.log(`scenario: ${scenarioName} ${JSON.stringify(scenario)}`);

  const intFlag = (name, def) => {
    const i = argv.indexOf(name);
    if (i < 0) return def;
    const v = Number(argv[i + 1]);
    if (!Number.isInteger(v) || v <= 0) {
      console.error(`${name} must be a positive integer`);
      process.exit(2);
    }
    return v;
  };
  const rounds = intFlag('--rounds', 12);
  const maxIter = intFlag('--max-iter', 2000);

  // ---- 1. Optimize, recording every accepted step ----
  const events = [];
  const t0 = performance.now();
  const { x, history } = optimize({
    scenario,
    rounds,
    maxIter,
    onAccept: (ev) => events.push({ type: 'step', ...ev }),
    onMuRamp: (ev) => events.push({ type: 'mu-ramp', ...ev }),
  });
  const optMs = performance.now() - t0;

  console.log('penalty rounds:');
  for (const h of history) {
    console.log(
      `  round ${h.round}: mu=${h.mu} carbon=${h.carbon.toFixed(1)} kgCO2e ` +
      `maxViol=${h.maxViol.toExponential(2)} pgd-iters=${h.iters}`,
    );
  }
  const n = evaluateNumeric(x, scenario);
  const startX = PARAMS.map((p) => (p.lo + p.hi) / 2);
  const nStart = evaluateNumeric(startX, scenario);
  const nSteps = events.filter((e) => e.type === 'step').length;
  console.log('---');
  console.log(`optimum after ${(optMs / 1000).toFixed(1)}s: ` +
    `carbon ${nStart.carbon.toFixed(1)} -> ${n.carbon.toFixed(1)} kgCO2e ` +
    `(${((n.carbon / nStart.carbon - 1) * 100).toFixed(1)}%), ` +
    `${nSteps} accepted steps, ${events.length - nSteps} mu ramps`);
  const violated = n.constraints.filter((c) => c.g / (G_SCALE[c.name] ?? 1) > 1e-6);
  console.log(`  violated constraints: ${violated.length === 0 ? 'none' : JSON.stringify(violated)}`);

  // ---- 2. Build the certificate chain ----
  const tc0 = performance.now();
  const chain = await buildChain({
    scenarioName,
    scenario,
    startX,
    events,
    optimizer: { startMu: 10, muFactor: 4, stepInit: 0.1, armijoC: 1e-4, btMax: 40 },
    kernelIdentity: getKernelIdentity(),
  });
  const chainMs = performance.now() - tc0;
  console.log(`certificate chain: ${chain.steps} step certificates built in ${(chainMs / 1000).toFixed(1)}s`);
  console.log(`  start root: ${chain.startRoot}`);
  console.log(`  final root: ${chain.finalState.root}`);

  // ---- 3. Endpoint grounding: kernel checks bound into the final cert ----
  // Seeded build: the optimum IFC's RAW bytes become a pure function of the
  // final parameters + this descriptor, so the endpoint certificate binds a
  // re-derivable raw sha256 (canonical hash stays as the fallback pin).
  const ifcBuild = {
    mode: 'seeded',
    spec: SEEDED_BUILD_SPEC,
    guidSeed: `diff-spike:${scenarioName}`,
    timestampMs: Date.UTC(2024, 0, 1),
  };
  const ep = await endpointChecks({ x, outDir, fileBase: 'optimum', scenario, ifcBuild });
  const endpoint = await attachEndpoint(chain, x, ep);
  console.log(`endpoint certificate: root ${endpoint.endpointRoot}`);
  console.log(`  ifc ${endpoint.ifcSha256} (${endpoint.ifcBytes} bytes, seeded build: raw hash re-derivable)`);

  // ---- 4. Persist ----
  const chainPath = path.join(outDir, 'trajectory-chain.json');
  const json = JSON.stringify(chain);
  writeFileSync(chainPath, json);
  console.log('---');
  console.log(`chain written: ${chainPath} (${(json.length / 1e6).toFixed(1)} MB, ` +
    `${chain.records.length} records)`);
  console.log(`verify with: node scripts/moonshot/diff-spike/verify-trajectory.mjs ${chainPath}`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
