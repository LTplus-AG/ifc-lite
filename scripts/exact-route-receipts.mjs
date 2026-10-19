/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compare, difference } from './exact-route-compare.mjs';
import { gitSource, verifyFleet, verifyHarnessManifest } from './exact-route-source.mjs';
import { verifyExecutedBinary } from './exact-route-binary.mjs';
import { digest } from './exact-route-inputs.mjs';
import { compareReviewedGraph } from './exact-route-graph.mjs';
import { compareUnitPolicies } from './exact-route-units.mjs';
import { compilerEnvironment, compilerEvidence } from './exact-route-compiler.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

export function compareReceipts(aDir, bDir, expectedBase, expectedBranch, manifest, evidence) {
  if (!evidence?.gitRepository || evidence.fleetReceipts?.length !== 2 || evidence.fleetLogs?.length !== 2 || !evidence.manifestPath) throw Error('independent Git, manifest and terminal fleet receipts required');
  verifyHarnessManifest(manifest);
  const manifestBytes = readFileSync(evidence.manifestPath);
  if (difference(JSON.parse(manifestBytes), manifest)) throw Error('independent manifest mismatch');
  if (![manifest.preCommonProgramBase, manifest.immediateIntegrationParent].includes(expectedBase)) {
    throw Error('comparison base is not a pinned original revision; repaired reproduction cannot qualify it');
  }
  const read = (dir, p) => JSON.parse(readFileSync(resolve(dir, p), 'utf8'));
  const a = read(aDir, 'receipt.json'), b = read(bDir, 'receipt.json');
  const fleets = [];
  for (const [i, receipt, head, dir] of [[0, a, expectedBase, aDir], [1, b, expectedBranch, bDir]]) {
    if (typeof receipt.toolchain !== 'string' || !receipt.toolchain || typeof receipt.cargo !== 'string' || !receipt.cargo ||
        !receipt.runtime || typeof receipt.runtime.platform !== 'string' || typeof receipt.runtime.arch !== 'string' ||
        !Number.isSafeInteger(receipt.runtime.availableParallelism) || receipt.runtime.availableParallelism < 1 ||
        receipt.status !== 'captured-uncompared' || receipt.source !== head ||
        !(/^[a-f0-9]{64}$/.test(receipt.binary?.sha256 ?? '')) || receipt.protocol !== 'exact-route-v2' ||
        receipt.manifestSha256 !== sha(manifestBytes) ||
        difference(receipt.harness, manifest.harness) || receipt.harnessSha256 !== manifest.harnessSha256 ||
        difference(receipt.options, manifest.options) ||
        receipt.fixtures?.length !== manifest.fixtures.length) throw Error('incomplete/wrong-source receipt');
    if (receipt.binary.artifact !== 'capture-binary' || sha(readFileSync(resolve(dir, receipt.binary.artifact))) !== receipt.binary.sha256) throw Error('binary artifact hash mismatch');
    const source = gitSource(evidence.gitRepository, head, receipt.executionCommit, manifest);
    for (const key of Object.keys(source)) if (difference(source[key], receipt[key])) throw Error(`Git blob/tree mismatch: ${key}`);
    compilerEnvironment(receipt.environment);
    const invocations = readFileSync(resolve(dir, 'compiler-invocations.jsonl'));
    const artifacts = readFileSync(resolve(dir, 'cargo-artifacts.jsonl'));
    const verbose = readFileSync(resolve(dir, 'cargo-stderr.log'));
    const lines = raw => raw.toString().trim().split('\n').filter(Boolean).map(s => JSON.parse(s));
    const context = read(dir, 'compiler-context.json'), files = read(dir, 'compiler-artifact-hashes.json');
    if (digest(context) !== receipt.compilerContextSha256 || difference(context.source, source) ||
        context.workspaceRoot !== receipt.cwd || context.toolchain !== receipt.toolchain ||
        context.cargo !== receipt.cargo || difference(context.environment, receipt.environment)) throw Error('compiler context/source mismatch');
    const compiler = compilerEvidence(lines(invocations), lines(artifacts), context, files);
    if (difference(compiler.units, receipt.compiler?.units) || difference(compiler.events, receipt.compiler?.events) ||
        difference(compiler.exampleProfile, receipt.compiler?.exampleProfile) ||
        difference(compiler.exampleFeatures, receipt.compiler?.exampleFeatures) || difference(compiler.policies, receipt.compiler?.policies) ||
        receipt.compiler.invocationSha256 !== sha(invocations) ||
        receipt.compiler.artifactEventsSha256 !== sha(artifacts) || receipt.compiler.verboseLogSha256 !== sha(verbose)) {
      throw Error('effective compiler evidence mismatch');
    }
    const example = lines(artifacts).findLast(a => a.reason === 'compiler-artifact' && a.target?.name === 'exact_route_capture' && a.executable);
    verifyExecutedBinary(receipt, dir, example, files);
    if (example.executable !== receipt.binary.path || compiler.policies.some(p => p.version !== receipt.toolchain)) throw Error('compiler/binary identity mismatch');
    fleets.push(verifyFleet(evidence.fleetReceipts[i], evidence.fleetLogs[i], resolve(dir, 'receipt.json'), receipt, source));
  }
  for (const key of ['harness', 'harnessSha256', 'manifestSha256', 'toolchain', 'cargo', 'options', 'runtime']) {
    if (difference(a[key], b[key])) throw Error(`receipt mismatch: ${key}`);
  }
  const environment = r => Object.fromEntries(Object.entries(r.environment).filter(([k]) => k !== 'CARGO_TARGET_DIR'));
  if (difference(environment(a), environment(b))) throw Error('compiler/worker environment mismatch');
  for (const key of ['exampleProfile', 'exampleFeatures', ...(evidence.graphPath ? [] : ['policies'])]) {
    if (difference(a.compiler[key], b.compiler[key])) throw Error(`effective compiler setting mismatch: ${key}`);
  }
  let graph = null;
  if (evidence.graphPath) graph = compareReviewedGraph(a, b, { bytes: readFileSync(evidence.graphPath) }, evidence.graphSha256);
  else compareUnitPolicies(a.compiler.units, b.compiler.units);
  const results = [];
  for (const [i, fixture] of manifest.fixtures.entries()) {
    const captures = [[aDir, a], [bDir, b]].map(([dir, receipt]) => {
      const record = receipt.fixtures[i];
      if (record.path !== fixture.path || record.sha256 !== fixture.sha256) throw Error('fixture receipt mismatch');
      const raw = readFileSync(resolve(dir, record.capture));
      if (sha(raw) !== record.captureSha256) throw Error('capture hash mismatch');
      const parsed = JSON.parse(raw);
      if (parsed.fixture_sha256 !== fixture.sha256 || parsed.options !== manifest.options) throw Error('captured fixture mismatch');
      return parsed;
    });
    results.push({ path: fixture.path, ...compare(captures[0], captures[1], manifest.options) });
  }
  return { equal: results.every(r => r.equal), results, fleets, graph,
    scope: 'listed ordered ordinary process_geometry outputs only; coverage gaps remain in manifest' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [a, b, base, branch, manifestPath, gitRepository, baseFleet, branchFleet, baseFleetLog, branchFleetLog, graphPath, graphSha256] = process.argv.slice(2);
    if (!manifestPath || !gitRepository || !baseFleet || !branchFleet || !baseFleetLog || !branchFleetLog) throw Error('usage: exact-route-receipts.mjs BASE_DIR BRANCH_DIR BASE_HEAD BRANCH_HEAD MANIFEST GIT_REPOSITORY BASE_FLEET_RECEIPT BRANCH_FLEET_RECEIPT BASE_FLEET_LOG BRANCH_FLEET_LOG [REVIEWED_GRAPH EXPECTED_GRAPH_SHA256]');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    for (const dir of [a, b]) {
      const receipt = JSON.parse(readFileSync(resolve(dir, 'receipt.json')));
      if (receipt.manifestSha256 !== sha(readFileSync(manifestPath))) throw Error('manifest hash mismatch');
    }
    const result = compareReceipts(a, b, base, branch, manifest, { gitRepository, fleetReceipts: [baseFleet, branchFleet], fleetLogs: [baseFleetLog, branchFleetLog], manifestPath, graphPath, graphSha256 });
    console.log(JSON.stringify(result, null, 2)); process.exitCode = result.equal ? 0 : 1;
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
