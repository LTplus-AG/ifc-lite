/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { auditRoot } from './check-workflow-report-paths.mjs';

function fixture(workflows, packages = {}) {
  const root = mkdtempSync(join(tmpdir(), 'workflow-report-paths-'));
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  for (const [name, text] of Object.entries(workflows)) {
    writeFileSync(join(root, '.github', 'workflows', name), text);
  }
  for (const [name, json] of Object.entries(packages)) {
    const dir = join(root, 'packages', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify(json));
  }
  return root;
}

test('the real repository has a zero finding baseline', () => {
  assert.deepEqual(auditRoot(join(import.meta.dirname, '..')), []);
});

test('#4144 history: an unbounded job and passWithNoTests both fail the audit', (context) => {
  const root = fixture({ 'old.yml': 'jobs:\n  gate:\n    runs-on: ubuntu-latest\n    steps: []\n' }, {
    old: { scripts: { test: 'vitest run --passWithNoTests' } },
  });
  context.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(auditRoot(root), [
    '.github/workflows/old.yml: job gate has no timeout-minutes',
    'packages/old/package.json: test command permits zero collected tests',
  ]);
});

// #4809 made docker.yml's timeout-minutes an expression (180 on a release, 120
// otherwise). The audit read it as "no timeout-minutes" and went red on a job
// that is bounded.
//
// `expr` builds the `${{ ... }}` wrapper from a template literal with an escaped
// `$`: the same text in a regular string trips eslint(no-template-curly-in-string).
const expr = (body) => `\${{ ${body} }}`;
const jobWithTimeout = (timeout) => `jobs:\n  build:\n    runs-on: ubuntu-latest\n    timeout-minutes: ${timeout}\n    steps: []\n`;
const boundedMessage = (name, timeout) =>
  `.github/workflows/${name}: job build has a timeout-minutes this audit cannot prove bounded: ${JSON.stringify(timeout)}`;

test('#4809: an expression timeout-minutes is accepted when both value positions are positive integers', (context) => {
  const accepted = {
    // docker.yml's real shape: the condition carries its own `||` inside parens,
    // so the split that finds the ternary has to respect paren depth.
    'nested.yml': expr("(github.event_name == 'release' || inputs.release_tag != '') && 180 || 120"),
    'simple.yml': expr("github.event_name == 'release' && 180 || 120"),
    'bare.yml': expr('120'),
    // A condition is not a value, so a numeral compared against inside one must
    // not be read as the timeout. Scanning literals anywhere made `'v1.0'` look
    // like a zero and failed a job bounded at 180/120.
    'ver.yml': expr("inputs.tag == 'v1.0' && 180 || 120"),
    'zeroish.yml': expr("inputs.mode == '0' && 60 || 90"),
    // A quoted operator is an operand, not a split point.
    'quoted.yml': expr("inputs.sep == '||' && 180 || 120"),
    'parens.yml': expr('inputs.long && (180) || (120)'),
    // A longer `&&` chain adds conditions, not value positions: it yields its
    // last conjunct, or a falsy one the `||` then replaces, so 180/120 still.
    'conjuncts.yml': expr('inputs.a && inputs.b && 180 || 120'),
  };
  const root = fixture(Object.fromEntries(
    Object.entries(accepted).map(([name, timeout]) => [name, jobWithTimeout(timeout)]),
  ));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(auditRoot(root), []);
});

test('#4809: an expression whose value is not provably a positive integer fails', (context) => {
  const rejected = {
    'zero.yml': expr("github.event_name == 'release' && 180 || 0"),
    'opaque.yml': expr('vars.TIMEOUT'),
    'fallback.yml': expr('inputs.long && 180 || vars.FALLBACK'),
    'negative.yml': expr('inputs.short && -30 || 120'),
    'halfternary.yml': expr('inputs.long && 180'),
    // A chain's MIDDLE branch is a value too. `-30` is truthy, so this yields
    // -30 when inputs.short holds, and a rule that checked only the first and
    // last branch would call it bounded.
    'chain.yml': expr('inputs.short && -30 || inputs.long && 120 || 180'),
    'chainpositive.yml': expr('inputs.a && 60 || inputs.b && 120 || 180'),
    // Bounded at 60/120, but only the documented two-branch idiom is accepted:
    // reading a longer alternation means reasoning about which branches are
    // reachable, and this audit does not evaluate expressions.
    'chainliteral.yml': expr('inputs.a && 60 || 120 || 180'),
    // Two spliced expressions. Without the anchor the body spans the `}} ${{`
    // gap and parses as one ternary; `expr('vars.T') + ' minutes'` cannot show
    // this, because it is rejected for its shape either way.
    'spliced.yml': `${expr('5')} ${expr('inputs.x && 10 || 20')}`,
    'trailing.yml': `${expr('120')} minutes`,
    'prose.yml': `${expr('vars.T')} minutes`,
  };
  const root = fixture(Object.fromEntries(
    Object.entries(rejected).map(([name, timeout]) => [name, jobWithTimeout(timeout)]),
  ));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const expected = Object.entries(rejected).map(([name, timeout]) => boundedMessage(name, timeout));
  assert.deepEqual([...auditRoot(root)].sort(), expected.sort());
});

// A YAML anchor can make the value a self-referential node. The audit must
// report the job, not die stringifying it.
test('#4809: a non-primitive timeout-minutes is reported rather than crashing the audit', (context) => {
  const root = fixture({
    'anchor.yml': 'jobs: &cyc\n  build:\n    runs-on: ubuntu-latest\n    timeout-minutes: *cyc\n    steps: []\n',
  });
  context.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(auditRoot(root), [
    '.github/workflows/anchor.yml: job build has a timeout-minutes this audit cannot prove bounded: a mapping',
  ]);
});

test('an artifact upload must actively fail on absence', (context) => {
  const root = fixture({
    'old.yml': 'jobs:\n  wheel:\n    runs-on: ubuntu-latest\n    timeout-minutes: 1\n    steps:\n      - uses: actions/upload-artifact@sha\n        with:\n          path: dist/*.whl\n',
  });
  context.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(auditRoot(root), ['.github/workflows/old.yml: artifact upload does not fail when its input is absent']);
  const path = join(root, '.github', 'workflows', 'old.yml');
  writeFileSync(path, `${readFileSync(path, 'utf8')}          if-no-files-found: error\n`);
  assert.deepEqual(auditRoot(root), []);
});

test('missing or malformed workflow trees fail closed', (context) => {
  const missing = mkdtempSync(join(tmpdir(), 'workflow-report-paths-missing-'));
  const empty = fixture({});
  const malformed = fixture({ 'bad.yml': '# jobs:\n#   fake:\n#     timeout-minutes: 1\n' });
  const invalid = fixture({ 'duplicate.yml': 'jobs:\n  gate:\n    runs-on: ubuntu-latest\n    runs-on: windows-latest\n' });
  context.after(() => [missing, empty, malformed, invalid].forEach((root) => rmSync(root, { recursive: true, force: true })));
  assert.match(auditRoot(missing)[0], /workflows is missing/);
  assert.match(auditRoot(empty)[0], /contains no YAML/);
  assert.match(auditRoot(malformed)[0], /missing parseable jobs tree/);
  assert.match(auditRoot(invalid)[0], /invalid YAML.*Map keys must be unique/s);
});

test('comments cannot satisfy active evidence steps or reporters', (context) => {
  const root = fixture({
    'determinism.yml': 'jobs:\n  gate:\n    runs-on: ubuntu-latest\n    timeout-minutes: 1\n#      - name: Assert native determinism targets contain runnable tests\n#  report-scheduled-failure:\n#    uses: ./.github/workflows/report-scheduled-failure.yml\n',
  });
  context.after(() => rmSync(root, { recursive: true, force: true }));
  assert.ok(auditRoot(root).some((failure) => failure.includes('missing active fail-closed step')));
  assert.ok(auditRoot(root).some((failure) => failure.includes('missing active scheduled failure reporter')));
});

test('a named fail-closed step cannot be disabled or allowed to fail', (context) => {
  const workflow = (guard) => `jobs:
  gate:
    runs-on: ubuntu-latest
    timeout-minutes: 1
    steps:
      - name: Run canary bundles
        ${guard}
        run: node scripts/ci-run-sdk-canaries.mjs
`;
  const root = fixture({ 'sdk-canary.yml': workflow('if: false') });
  context.after(() => rmSync(root, { recursive: true, force: true }));
  assert.ok(auditRoot(root).some((failure) => failure.includes('missing active fail-closed step')));
  writeFileSync(join(root, '.github', 'workflows', 'sdk-canary.yml'), workflow('continue-on-error: true'));
  assert.ok(auditRoot(root).some((failure) => failure.includes('missing active fail-closed step')));
  writeFileSync(join(root, '.github', 'workflows', 'sdk-canary.yml'), workflow(`continue-on-error: \${{ true }}`));
  assert.ok(auditRoot(root).some((failure) => failure.includes('missing active fail-closed step')));
  writeFileSync(join(root, '.github', 'workflows', 'sdk-canary.yml'), workflow('shell: bash -n {0}'));
  assert.ok(auditRoot(root).some((failure) => failure.includes('missing active fail-closed step')));
  writeFileSync(join(root, '.github', 'workflows', 'sdk-canary.yml'), workflow(''));
  assert.deepEqual(auditRoot(root), []);
  writeFileSync(join(root, '.github', 'workflows', 'sdk-canary.yml'), workflow('').replace(
    'run: node scripts/ci-run-sdk-canaries.mjs',
    "run: |\n          : <<'GUARD_DOC'\n          node scripts/ci-run-sdk-canaries.mjs\n          GUARD_DOC"
  ));
  assert.ok(auditRoot(root).some((failure) => failure.includes('missing active fail-closed step')));
  writeFileSync(join(root, '.github', 'workflows', 'sdk-canary.yml'), workflow('').replace('runs-on: ubuntu-latest', 'runs-on: ubuntu-latest\n    continue-on-error: true'));
  assert.ok(auditRoot(root).some((failure) => failure.includes('missing active fail-closed step')));
  writeFileSync(join(root, '.github', 'workflows', 'sdk-canary.yml'), workflow('').replace('runs-on: ubuntu-latest', 'runs-on: ubuntu-latest\n    defaults:\n      run:\n        shell: bash -n {0}'));
  assert.ok(auditRoot(root).some((failure) => failure.includes('missing active fail-closed step')));
  writeFileSync(join(root, '.github', 'workflows', 'sdk-canary.yml'), `defaults:\n  run:\n    shell: bash -n {0}\n${workflow('')}`);
  assert.ok(auditRoot(root).some((failure) => failure.includes('missing active fail-closed step')));
});

test('reporters cover every non-success dependency and reject inert conditions', (context) => {
  const scheduled = `jobs:
  content-matching-fixture:
    runs-on: ubuntu-latest
    timeout-minutes: 1
    steps: []
  report-scheduled-failure:
    needs: content-matching-fixture
    if: always() && github.event_name == 'schedule' && needs.content-matching-fixture.result != 'success'
    uses: ./.github/workflows/report-scheduled-failure.yml
`;
  const main = `jobs:
  validate-server-binaries:
    runs-on: ubuntu-latest
    timeout-minutes: 1
    steps: []
  validate-server-binaries-cross:
    runs-on: ubuntu-latest
    timeout-minutes: 1
    steps: []
  report-red-on-main:
    needs: [validate-server-binaries, validate-server-binaries-cross]
    if: always() && github.event_name == 'push' && github.ref == 'refs/heads/main' && (needs.validate-server-binaries.result != 'success' || needs.validate-server-binaries-cross.result != 'success')
    runs-on: ubuntu-latest
    timeout-minutes: 1
    permissions:
      issues: write
    steps:
      - run: gh issue create --title red
`;
  const root = fixture({ 'xmatch-fixture.yml': scheduled, 'server-binaries.yml': main });
  context.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(auditRoot(root), []);
  const scheduledPath = join(root, '.github', 'workflows', 'xmatch-fixture.yml');
  writeFileSync(scheduledPath, scheduled.replace(" != 'success'", " == 'failure'"));
  assert.ok(auditRoot(root).some((failure) => failure.includes('missing active scheduled failure reporter')));
  writeFileSync(scheduledPath, scheduled.replace(" != 'success'", " != 'success' && false"));
  assert.ok(auditRoot(root).some((failure) => failure.includes('missing active scheduled failure reporter')));
  writeFileSync(scheduledPath, `permissions:\n  issues: write\n${scheduled}`);
  assert.ok(auditRoot(root).some((failure) => failure.includes('missing active scheduled failure reporter')));
  writeFileSync(scheduledPath, scheduled);
  const mainPath = join(root, '.github', 'workflows', 'server-binaries.yml');
  writeFileSync(mainPath, main.replace("needs.validate-server-binaries-cross.result != 'success'", "needs.validate-server-binaries-cross.result == 'failure'"));
  assert.ok(auditRoot(root).some((failure) => failure.includes('partial main-only matrix')));
  writeFileSync(mainPath, main.replace(" != 'success' || needs.validate-server-binaries-cross", " != 'success' && needs.validate-server-binaries-cross"));
  assert.ok(auditRoot(root).some((failure) => failure.includes('partial main-only matrix')));
});

test('runtime reporters consume actual dependency and workflow conclusions', (context) => {
  const root = fixture({
    'ci-reporting-outcome-probe.yml': `jobs:
  subject:
    runs-on: ubuntu-latest
    timeout-minutes: 1
    steps:
      - name: Turn a real hang into a failed inner deadline
        run: timeout --signal=TERM 1s sleep 300; rc=$?; exit "$rc"
  report:
    needs: subject
    if: always()
    uses: ./.github/workflows/report-scheduled-failure.yml
    with:
      result: \${{ needs.subject.result }} output=\${{ needs.subject.outputs.evidence }} deadline=\${{ needs.subject.outputs.deadline }}
`,
    'ci-reporting-cancellation-observer.yml': `jobs:
  report-cancelled:
    if: github.event.workflow_run.conclusion == 'cancelled'
    uses: ./.github/workflows/report-scheduled-failure.yml
    with:
      result: \${{ github.event.workflow_run.conclusion }}
`,
  });
  context.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(auditRoot(root), []);
  const probe = join(root, '.github', 'workflows', 'ci-reporting-outcome-probe.yml');
  writeFileSync(probe, readFileSync(probe, 'utf8').replace('needs.subject.result', "'failure'"));
  assert.ok(auditRoot(root).some((failure) => failure.includes('actual dependency result')));
  const observer = join(root, '.github', 'workflows', 'ci-reporting-cancellation-observer.yml');
  writeFileSync(observer, readFileSync(observer, 'utf8').replace(`\${{ github.event.workflow_run.conclusion }}`, 'cancelled'));
  assert.ok(auditRoot(root).some((failure) => failure.includes('actual completed workflow conclusion')));
});

test('a main reporter whose steps no longer create an issue fails the audit', (context) => {
  const workflow = (steps) => `name: Server binaries
on:
  push:
    branches: [main]
jobs:
  validate-server-binaries:
    runs-on: ubuntu-latest
    timeout-minutes: 1
    steps: []
  validate-server-binaries-cross:
    runs-on: ubuntu-latest
    timeout-minutes: 1
    steps: []
  report-red-on-main:
    needs: [validate-server-binaries, validate-server-binaries-cross]
    if: always() && github.event_name == 'push' && github.ref == 'refs/heads/main' && (needs.validate-server-binaries.result != 'success' || needs.validate-server-binaries-cross.result != 'success')
    runs-on: ubuntu-latest
    timeout-minutes: 1
    permissions:
      issues: write
    steps:
${steps}
`;
  const variants = {
    good: '      - run: gh issue create --title red',
    goodMultiline: '      - run: |\n          set -e\n          if true; then\n            gh issue create --title red\n          fi',
    goodAlways: '      - if: always()\n        run: gh issue create --title red',
    inert: '      - run: echo ok',
    echoOnly: '      - run: echo "gh issue create"',
    disabled: '      - if: false\n        run: gh issue create --title red',
    tolerant: '      - continue-on-error: true\n        run: gh issue create --title red',
  };
  const roots = Object.fromEntries(Object.entries(variants).map(([k, steps]) => [k, fixture({ 'server-binaries.yml': workflow(steps) })]));
  context.after(() => Object.values(roots).forEach((root) => rmSync(root, { recursive: true, force: true })));
  const named = (root) => auditRoot(root).filter((f) => f.includes('partial main-only matrix'));
  for (const ok of ['good', 'goodMultiline', 'goodAlways']) assert.deepEqual(named(roots[ok]), [], ok);
  for (const bad of ['inert', 'echoOnly', 'disabled', 'tolerant']) assert.equal(named(roots[bad]).length, 1, bad);
});
