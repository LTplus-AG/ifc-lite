/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #7221 supported-domain qualification. The canonical oracle judges mutations.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, relative, join, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { classifyDiff, parseNameStatus } from '../lib/revert-oracle.mjs';
import { planRuns } from '../lib/revert-oracle-plan-runs.mjs';
import { runPlan } from '../lib/revert-oracle-run-plan.mjs';
const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const args = process.argv.slice(2);
const value = flag => { const at = args.indexOf(flag); assert.ok(at >= 0 && args[at + 1], `Missing ${flag}`); return args[at + 1]; };
const stage = value('--platform'), base = value('--base'), output = resolve(value('--output'));
assert.ok(['windows', 'posix'].includes(stage), 'Unknown supported Job domain');
assert.equal(process.platform === 'win32', stage === 'windows', 'Actual runner OS must match the required domain');
const outside = relative(root, output);
assert.ok(isAbsolute(outside) || outside === '..' || outside.startsWith('..' + sep), 'CI evidence must be outside the clean source checkout');
mkdirSync(output, { recursive: true });
const record = (name, data) => writeFileSync(join(output, name), typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
const git = (...argv) => {
  const result = spawnSync('git', argv, { cwd: root, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr); return result.stdout.trim();
};
assert.equal(git('status', '--porcelain'), '', 'Qualification requires clean source');
const head = git('rev-parse', 'HEAD');
const classification = classifyDiff(parseNameStatus(git('diff', '--name-status', `${base}...HEAD`)));
const selected = classification.platforms[stage].map(row => row.path);
const paths = stage === 'windows'
  ? ['scripts/perf/frame-gpu-job.test.mjs', 'scripts/perf/frame-gpu-job-controller.test.mjs']
  : ['scripts/perf/frame-gpu-job-controller.test.mjs'];
const nativeSubjects = {
  'scripts/perf/frame-gpu-job.test.mjs': 'native-kill-on-close',
  'scripts/perf/frame-gpu-job-controller.test.mjs': 'native-exact-identity',
};
const mutations = Object.fromEntries(paths.map(file => [file,
  `scripts/perf/evidence/worker-pool-lifecycle-7036/native-ci/${stage === 'posix' ? 'posix-no-start' : nativeSubjects[file]}.mutation.patch`]));
assert.ok(selected.every(file => Object.hasOwn(mutations, file)), 'Changed native subject requires its own safe mutation');
const sourceNames = ['frame-gpu-process-identity.cs', 'frame-gpu-job.cs', 'frame-gpu-job-input.cs',
  'frame-gpu-job-supervisor.ps1', 'frame-gpu-cpu-fixture.cs', 'frame-gpu-cpu-fixture.mjs',
  'frame-gpu-job-controller.ts', 'frame-gpu-job.test.mjs', 'frame-gpu-job-controller.test.mjs'];
const pins = Object.fromEntries([...sourceNames.map(name => 'scripts/perf/' + name), ...new Set(Object.values(mutations))].map(path =>
  [path, createHash('sha256').update(readFileSync(join(root, path))).digest('hex')]));
// A clean Git status can conceal checkout newline conversion. Pin raw blob bytes.
const sourceBlobComparisons = Object.entries(pins).map(([path, observedSha256]) => {
  const blob = spawnSync('git', ['show', `${head}:${path}`], { cwd: root, timeout: 10000, maxBuffer: 16 * 1024 * 1024 });
  return { path, observedSha256, blobSha256: blob.status === 0 ? createHash('sha256').update(blob.stdout).digest('hex') : null,
    blobExitCode: blob.status, blobError: blob.error?.message ?? blob.stderr?.toString('utf8') ?? null };
});
record('admission.json', { head, base, stage, OS: process.platform, node: process.version, selected, paths, mutations, pins,
  sourceBlobComparisons, allChangedTests: classification.test.map(row => row.path), platforms: classification.platforms });
for (const row of sourceBlobComparisons) {
  assert.equal(row.blobExitCode, 0, `Cannot read pinned HEAD blob ${row.path}: ${row.blobError}`);
  assert.equal(row.observedSha256, row.blobSha256, `Actual pinned source differs from HEAD blob bytes: ${row.path}`);
}
process.env.IFC_JOB_EVIDENCE_ROOT = join(output, 'actual-fixtures');
process.env.IFC_JOB_PLATFORM = stage;
process.env.IFC_JOB_REQUIRE_NATIVE = stage === 'windows' ? '1' : '0';
const planned = planRuns(paths, root);
assert.deepEqual(planned.unassigned, []); assert.deepEqual(planned.support, []);
assert.equal(planned.plans.length, paths.length);
const positive = label => {
  const rows = planned.plans.map(plan => {
    const result = runPlan({ ...plan, onOutput: raw => record(`${label}-${paths.indexOf(plan.file)}-raw.json`, raw) }, root, label);
    record(`${label}-${paths.indexOf(plan.file)}-parsed.json`, result);
    const expectedPass = stage === 'posix' ? 2 : plan.file.endsWith('frame-gpu-job.test.mjs') ? 4 : 5;
    const expectedTotal = plan.file.endsWith('frame-gpu-job.test.mjs') ? 4 : 7;
    assert.equal(result.kind, 'pass', 'Actual supported-domain positive must pass');
    assert.equal(result.attributed, true, 'Actual exact test file must execute');
    assert.equal(result.rawExitCode, 0); assert.equal(result.signal, null);
    assert.equal(result.failed, 0); assert.equal(result.passed, expectedPass); assert.equal(result.total, expectedTotal);
    return { file: plan.file, passed: result.passed, total: result.total };
  });
  assert.equal(rows.reduce((sum, row) => sum + row.passed, 0), stage === 'windows' ? 9 : 2);
  return rows;
};
let primary, restored, baseline;
try {
  baseline = positive('original');
  assert.equal(git('status', '--porcelain'), '', 'Positive fixtures must leave clean source');
  for (const [index, file] of selected.entries()) {
    const mutation = mutations[file];
    const oracle = spawnSync(process.execPath, ['scripts/check-test-revert-oracle.mjs', '--base', base, '--ci', '--json',
      '--platform', stage, '--test', file, '--mutation', mutation], { cwd: root, encoding: 'utf8', timeout: 600000,
      maxBuffer: 32 * 1024 * 1024, env: { ...process.env, IFC_LITE_ORACLE_RAW_OUTPUT: '1' } });
    record(`oracle-${index}-stdout.log`, oracle.stdout ?? ''); record(`oracle-${index}-stderr.log`, oracle.stderr ?? '');
    record(`oracle-${index}-terminal.json`, { file, mutation, exitCode: oracle.status, signal: oracle.signal, spawnError: oracle.error?.message ?? null });
    assert.equal(oracle.status, 0, oracle.error?.message ?? oracle.stderr); assert.equal(oracle.signal, null);
    // Transport the canonical result; do not reconstruct its ledger/verdict from status.
    const at = oracle.stdout.lastIndexOf('\n{\n');
    assert.ok(at >= 0, 'Canonical structured observer result is required');
    const result = JSON.parse(oracle.stdout.slice(at + 1));
    record(`oracle-${index}-result.json`, result);
    assert.equal(result.head, head); assert.equal(result.verdict, 'OBSERVED');
    assert.equal(result.restoration, 'verified');
  }
} catch (error) { primary = error; }
finally {
  try {
    assert.equal(git('status', '--porcelain'), '', 'Existing oracle must restore clean exact source');
    assert.equal(git('rev-parse', 'HEAD'), head);
    for (const [path, hash] of Object.entries(pins)) assert.equal(createHash('sha256').update(readFileSync(join(root, path))).digest('hex'), hash);
    restored = positive('restored');
  } catch (error) { primary = primary ? new AggregateError([primary, error], 'Primary/restore qualification failure') : error; }
  record('terminal.json', { head, stage, baseline, restored, changedDomainTests: selected,
    oracleRequired: selected.length > 0, success: !primary, error: primary ? String(primary.stack ?? primary) : null,
    scope: 'Native Windows CPU Job controls or real POSIX no-start controls; no Chrome/GPU/performance acceptance' });
}
if (primary) throw primary;
