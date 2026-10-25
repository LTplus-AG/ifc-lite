/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// One-off qualification for testing-optimization. Run in an admitted disposable
// checkout AFTER root builds/typechecking. Every observer uses root pnpm/Turbo;
// --only reuses those prepared dependency builds during source-only mutations.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import { parseRunnerOutput, PASS, ASSERTION_FAILURE } from './lib/revert-oracle.mjs';
import { withRestoredSource } from './lib/restored-source.mjs';

if (!process.env.IFC_WORKER_ACTIVE_STATE) throw new Error('Use the registered fleet/worker launcher');
const root = process.cwd();
const hash = value => createHash('sha256').update(value).digest('hex');
for (const path of ['packages/parser/dist/index.js', 'packages/geometry/dist/index.js',
  'packages/wasm/pkg/ifc-lite_bg.wasm']) {
  if (!existsSync(resolve(root, path))) throw new Error(`Prepare root dependency builds first: ${path}`);
}
const reports = [];
const viewer = { family: 'node-test', args: ['--filter=@ifc-lite/viewer'],
  pattern: 'src/components/error-report/ErrorReportDialog.test.tsx|authoring-sample-fixture.startup' };
const packagePlan = name => ({ family: 'vitest', args: [`--filter=@ifc-lite/${name}`],
  tail: ['--', 'wasm-init-retry.test.ts', 'wasm-panic-forward.test.ts'] });
const controls = [['viewer', viewer], ...['parser', 'geometry', 'wasm-lifecycle'].map(name => [name, packagePlan(name)])];

function run(label, plan) {
  const command = ['test', ...plan.args, '--only', '--concurrency=1', '--log-prefix=none', ...(plan.tail ?? [])];
  const started = performance.now();
  const result = spawnSync('pnpm', command, { cwd: root,
    env: { ...process.env, TEST_PATTERN: plan.pattern ?? '' }, encoding: 'utf8',
    timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
  const output = stripVTControlCharacters(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  // Node's spec reporter and TAP carry the same summary fields.
  const parsed = parseRunnerOutput({ family: plan.family, stdout: output.replace(/^ℹ /gm, '# '),
    exitCode: result.status, signal: result.signal, spawnError: result.error?.message });
  const report = { label, command: ['pnpm', ...command], selector: plan.pattern,
    elapsedMs: Math.round(performance.now() - started), exitCode: result.status,
    outputSha256: hash(output), result: parsed,
    failureExcerpt: result.status ? output.split('\n').filter(line =>
      /AssertionError|ERR_ASSERTION|expected|actual|Parser-only fixture|✖ |FAIL |× /.test(line)).slice(-12) : [] };
  reports.push(report);
  console.log(JSON.stringify(report));
  return { report, output };
}
function replace(text, before, after) {
  if (!text.includes(before)) throw new Error(`Mutation anchor drift: ${before}`);
  return text.replaceAll(before, after);
}
function mutation(label, path, mutate, plan, expectedMessage) {
  const full = resolve(root, path), original = readFileSync(full);
  const changed = mutate(original.toString('utf8'));
  if (hash(changed) === hash(original)) throw new Error(`Mutation did not change ${path}`);
  withRestoredSource(full, () => {
    writeFileSync(full, changed);
    const { report, output } = run(label, plan);
    report.path = path;
    report.originalSha256 = hash(original);
    report.mutatedSha256 = hash(changed);
    const observed = expectedMessage
      ? report.exitCode !== 0 && output.includes(expectedMessage)
      : report.result.kind === ASSERTION_FAILURE && report.result.failed > 0;
    if (!observed) throw new Error(`Mutation not observed through its intended witness: ${label}`);
  });
}

try {
  for (const [label, plan] of controls) {
    if (run(`${label}-baseline`, plan).report.result.kind !== PASS) throw new Error(`Broken baseline: ${label}`);
  }
  const dialog = 'apps/viewer/src/components/error-report/ErrorReportDialog.tsx';
  const dialogTest = resolve(root, 'apps/viewer/src/components/error-report/ErrorReportDialog.test.tsx');
  const old = spawnSync('git', ['show', '60a505e914:apps/viewer/src/components/error-report/ErrorReportDialog.test.tsx'],
    { cwd: root, maxBuffer: 1024 * 1024 });
  if (old.status !== 0) throw new Error('Original report suite is unavailable for timing comparison');
  const reportPlan = { ...viewer, pattern: 'src/components/error-report/ErrorReportDialog.test.tsx' };
  withRestoredSource(dialogTest, () => {
    writeFileSync(dialogTest, old.stdout);
    if (run('original-report-suite-shared-host', reportPlan).report.result.kind !== PASS) {
      throw new Error('Original report suite failed');
    }
  });
  if (run('optimized-report-suite-shared-host', reportPlan).report.result.kind !== PASS) {
    throw new Error('Optimized report suite failed');
  }
  for (const delay of [2999, 3001]) mutation(`poll-interval-${delay}`, dialog,
    source => replace(source, '}, 3000);', `}, ${delay});`), viewer);
  mutation('scheduled-poll-cleanup', dialog,
    source => replace(source, 'clearTimeout(timer); controller.abort();', 'controller.abort();'), viewer);
  mutation('in-flight-poll-abort', dialog,
    source => replace(source, 'clearTimeout(timer); controller.abort();', 'clearTimeout(timer);'), viewer);
  mutation('late-response-guard', dialog,
    source => replace(source, 'if (controller.signal.aborted) return;', ''), viewer);
  mutation('eager-viewer-fixture-import', 'apps/viewer/src/test/authoring-sample-fixture.ts',
    source => `import '@/store';\n${source}`, viewer, 'Parser-only fixture loaded viewer state:');
  for (const consumer of ['parser', 'geometry']) {
    mutation(`${consumer}-retry-forwarding`, `packages/${consumer}/src/wasm-init-retry.ts`,
      source => `${replace(source, '  initWasmWithRetry,\n', '')}\n` +
        'export const initWasmWithRetry: typeof import("@ifc-lite/wasm-lifecycle").initWasmWithRetry = async () => {};\n', packagePlan(consumer));
    mutation(`${consumer}-panic-forwarding`, `packages/${consumer}/src/wasm-panic-forward.ts`,
      source => `${replace(source, '  WASM_PANIC_STASH_KEY,\n', '')}\n` +
        'export const WASM_PANIC_STASH_KEY = "incorrect-stash-key";\n', packagePlan(consumer));
  }
  for (const [label, plan] of controls) {
    if (run(`${label}-restored`, plan).report.result.kind !== PASS) throw new Error(`Restored run failed: ${label}`);
  }
  console.log(JSON.stringify({ qualification: 'passed', mutationsObserved: 10, reports }));
} catch (error) {
  console.error(JSON.stringify({ qualification: 'failed', error: String(error), reports }));
  process.exitCode = 1;
}
