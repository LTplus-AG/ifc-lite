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
    steps: []
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
