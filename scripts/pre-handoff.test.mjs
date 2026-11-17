/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gateCommands, main, runGates, oraclePrerequisites, unbuiltWorkspaceDeps } from './pre-handoff.mjs';
import { ciJobSkipReason } from './lib/pre-handoff-ci-mirror.mjs';

test('#7955 handoff keeps running after failures and distinguishes missing prerequisites', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'handoff-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), '{}');
  const lines = [];
  const rows = runGates(root, [
    { name: 'bad', args: ['-e', 'process.exit(7)'] },
    { name: 'good', args: ['-e', 'console.log("executed")'] },
    { name: 'deps', deps: ['nonexistent-handoff-dependency'], args: ['-e', 'process.exit(1)'] },
    { name: 'dist', needs: 'absent/dist', args: ['-e', 'process.exit(1)'] },
  ], (line) => lines.push(line));
  assert.deepEqual(rows.map((row) => row.result), ['FAIL', 'PASS', 'SKIPPED', 'SKIPPED']);
  assert.equal(rows[0].detail, 'exit 7');
  assert.ok(lines.some((line) => line.includes('executed')));
  assert.equal(lines.filter((line) => line.startsWith('SKIPPED')).length, 2);
});

test('#7955 selected base reaches diff-sensitive gates and license invocation is read-only', () => {
  const gates = gateCommands('custom/base');
  assert.ok(gates.find((gate) => gate.name === 'module-size').args.includes('custom/base'));
  assert.ok(gates.find((gate) => gate.name === 'source-text-assertions').args.includes('custom/base'));
  assert.ok(gates.find((gate) => gate.name === 'silent-revert').args.includes('custom/base'));
  assert.ok(gates.find((gate) => gate.name === 'license-headers').args.includes('--check'));
});

test('#7955 a registered witness with an unavailable runner is explicitly skipped', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'handoff-runner-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'packages/example'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{}');
  writeFileSync(join(root, 'packages/example/package.json'), '{"scripts":{"test":"vitest run"}}');
  writeFileSync(join(root, 'packages/example/witness.test.mjs'), '');
  const unavailable = oraclePrerequisites(root, { test: 'packages/example/witness.test.mjs' }, 'unused');
  assert.match(unavailable, /vitest/);
  const rows = runGates(root, [{ name: 'witness', unavailable, args: ['-e', 'process.exit(9)'] }], () => {});
  assert.equal(rows[0].result, 'SKIPPED');
});

test('an oracle over contrast harness tests is a named gap, not a launch failure, when the harness has no browser', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'handoff-contrast-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'apps/viewer/src/test/contrast'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{}');
  writeFileSync(join(root, 'apps/viewer/package.json'), '{"scripts":{"test":"tsx --test"}}');
  const harnessTest = 'apps/viewer/src/test/contrast/x.contrast.test.tsx';
  const plainTest = 'apps/viewer/src/test/contrast/plain.test.ts';
  writeFileSync(join(root, harnessTest), "import { withThemedPage } from './render-harness.js';\n");
  writeFileSync(join(root, plainTest), "import { contrastRatio } from './wcag';\n");

  const missing = oraclePrerequisites(root, { test: harnessTest }, 'unused', () => 'missing');
  assert.match(missing, /Google Chrome for the contrast harness \(1 test file\(s\)/);
  assert.equal(runGates(root, [{ name: 'witness', unavailable: missing, args: ['-e', 'process.exit(9)'] }], () => {})[0].result, 'SKIPPED');
  assert.doesNotMatch(oraclePrerequisites(root, { test: harnessTest }, 'unused', () => 'system-chrome') ?? '', /contrast harness/);
  // Counted, not thrown: oraclePrerequisites catches a probe error, so a throw here would pass unnoticed.
  let probes = 0;
  const counted = () => { probes += 1; return 'missing'; };
  assert.doesNotMatch(oraclePrerequisites(root, { test: plainTest }, 'unused', counted) ?? '', /contrast/);
  assert.equal(probes, 0, 'a test that does not use the harness is never probed');
});

test('a contrast browser probe that cannot run is a named gap, not a thrown failure', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'handoff-contrast-probe-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'apps/viewer/src/test'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{}');
  writeFileSync(join(root, 'apps/viewer/package.json'), '{"scripts":{"test":"tsx --test"}}');
  const dynamic = 'apps/viewer/src/test/dynamic.layout.test.tsx';
  writeFileSync(join(root, dynamic), "const h = await import('@/test/contrast/render-harness.js');\n");
  const broken = () => { throw new Error('contrast browser probe failed: tsx exited 1\nstack'); };
  assert.match(oraclePrerequisites(root, { test: dynamic }, 'unused', broken), /a contrast browser answer \(contrast browser probe failed: tsx exited 1\)/);
});

test('the CI mirror reads the REAL test.yml: oracle and ui-drift are gated on frontend/rust', () => {
  const workflow = readFileSync(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8');
  for (const job of ['revert-oracle', 'node-guards']) {
    assert.equal(ciJobSkipReason(workflow, job, ['scripts/pre-handoff.mjs']), null);
    assert.equal(ciJobSkipReason(workflow, job, ['rust/core/src/lib.rs']), null);
    assert.match(ciJobSkipReason(workflow, job, ['README.md']), new RegExp(`${job} job would not run: .*frontend/rust`));
  }
});

const MIRROR_WORKFLOW = `jobs:
  changes:
    steps:
      - uses: dorny/paths-filter
        with:
          filters: |
            frontend:
              - 'scripts/**'
            docs:
              - 'docs/**'
  revert-oracle:
    if: >-
      github.event_name == 'pull_request' &&
      needs.changes.outputs.frontend == 'true'
  node-guards:
    if: needs.changes.outputs.frontend == 'true'
`;

/** A git repo whose origin/main is one commit behind HEAD, with stub gate scripts. */
function mirrorRepo(t, { changed, oracleExit = 0, driftExit = 0 }) {
  const root = mkdtempSync(join(tmpdir(), 'handoff-mirror-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  const write = (path, text) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), text); };
  git('init', '-q', '-b', 'main');
  write('package.json', '{}');
  write('.github/workflows/test.yml', MIRROR_WORKFLOW);
  write('scripts/check-test-revert-oracle.mjs', `console.log('oracle', process.argv.slice(2).join(' ')); process.exit(${oracleExit});`);
  write('scripts/check-ui-drift.mjs', `process.exit(${driftExit});`);
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  for (const [path, text] of Object.entries(changed)) write(path, text);
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'change');
  return root;
}

function runMirror(root, argv = []) {
  const tables = [];
  const { log, table } = console;
  console.log = () => {};
  console.table = (rows) => tables.push(rows);
  try {
    const exitCode = main(argv, root, () => []);
    const rows = Object.fromEntries(tables[0].map((row) => [row.gate, row]));
    return { exitCode, oracle: rows['revert-oracle (CI changed-tests)'], drift: rows['ui-drift'] };
  } finally { Object.assign(console, { log, table }); }
}

const SCRIPT_CHANGE = { 'scripts/feature.mjs': 'export const x = 2;\n', 'scripts/feature.test.mjs': "import './feature.mjs';\n" };

test('pre-handoff runs both CI gates on a production change and passes when they pass', (t) => {
  const result = runMirror(mirrorRepo(t, { changed: SCRIPT_CHANGE }));
  assert.equal(result.oracle.result, 'PASS');
  assert.equal(result.drift.result, 'PASS');
  assert.equal(result.exitCode, 0);
});

test('a failing changed-tests oracle fails pre-handoff', (t) => {
  const result = runMirror(mirrorRepo(t, { changed: SCRIPT_CHANGE, oracleExit: 1 }));
  assert.deepEqual([result.oracle.result, result.drift.result, result.exitCode], ['FAIL', 'PASS', 1]);
});

test('a failing ui-drift ratchet fails pre-handoff', (t) => {
  const result = runMirror(mirrorRepo(t, { changed: SCRIPT_CHANGE, driftExit: 1 }));
  assert.deepEqual([result.oracle.result, result.drift.result, result.exitCode], ['PASS', 'FAIL', 1]);
});

test('both gates are SKIPPED with a reason when CI would not run them', (t) => {
  const result = runMirror(mirrorRepo(t, { changed: { 'docs/page.md': 'text\n' } }));
  assert.equal(result.oracle.result, 'SKIPPED');
  assert.match(result.oracle.detail, /revert-oracle job would not run/);
  assert.equal(result.drift.result, 'SKIPPED');
  assert.match(result.drift.detail, /node-guards job would not run/);
});

test('the oracle is SKIPPED when CI would run but nothing changed is production', (t) => {
  const result = runMirror(mirrorRepo(t, { changed: { 'scripts/only.test.mjs': 'export {};\n' } }));
  assert.equal(result.oracle.result, 'SKIPPED');
  assert.match(result.oracle.detail, /no changed file as production/);
  assert.equal(result.drift.result, 'PASS');
});

test('a missing base skips the oracle with the reason and still runs ui-drift', (t) => {
  const result = runMirror(mirrorRepo(t, { changed: SCRIPT_CHANGE, oracleExit: 1 }), ['--base', 'origin/absent']);
  assert.equal(result.oracle.result, 'SKIPPED');
  assert.match(result.oracle.detail, /origin\/absent not found/);
  assert.equal(result.drift.result, 'PASS');
  assert.equal(result.exitCode, 0);
});

test('an unbuilt workspace dependency is named as a missing prerequisite', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'handoff-unbuilt-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, text) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), text); };
  write('package.json', '{}');
  write('packages/app/package.json', JSON.stringify({ scripts: { test: 'node --test' }, devDependencies: { '@x/lib': 'workspace:*' } }));
  write('packages/app/witness.test.mjs', '');
  write('packages/app/node_modules/@x/lib/package.json', JSON.stringify({ name: '@x/lib', main: 'dist/index.js', scripts: { build: 'tsc' } }));
  assert.deepEqual(unbuiltWorkspaceDeps(join(root, 'packages/app')), ['@x/lib']);
  assert.match(oraclePrerequisites(root, { test: 'packages/app/witness.test.mjs' }, 'unused'), /built packages \(1 unbuilt, e\.g\. @x\/lib; run pnpm build\)/);
  write('packages/app/node_modules/@x/lib/dist/index.js', '');
  assert.deepEqual(unbuiltWorkspaceDeps(join(root, 'packages/app')), []);
});
