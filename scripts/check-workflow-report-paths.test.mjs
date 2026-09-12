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

test('the runtime reporter audit requires three independent outcome routes', (context) => {
  const root = fixture({
    'ci-reporting-selfcheck.yml': `jobs:
  failure-probe:
    runs-on: ubuntu-latest
    timeout-minutes: 1
  cancellation-probe:
    runs-on: ubuntu-latest
    timeout-minutes: 1
  deadline-probe:
    runs-on: ubuntu-latest
    timeout-minutes: 1
  report-failure:
    needs: failure-probe
    if: always()
    uses: ./.github/workflows/report-scheduled-failure.yml
    with:
      result: failure
  report-cancelled:
    needs: cancellation-probe
    if: always()
    uses: ./.github/workflows/report-scheduled-failure.yml
    with:
      result: cancelled
  report-deadline:
    needs: deadline-probe
    if: always()
    uses: ./.github/workflows/report-scheduled-failure.yml
    with:
      result: deadline-exceeded
`,
  });
  context.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(auditRoot(root), []);
  const path = join(root, '.github', 'workflows', 'ci-reporting-selfcheck.yml');
  writeFileSync(path, readFileSync(path, 'utf8').replace('needs: cancellation-probe', 'needs: failure-probe'));
  assert.ok(auditRoot(root).some((failure) => failure.includes('cancelled selfcheck')));
});
