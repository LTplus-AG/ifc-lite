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

test('a missing wheel is an error, while a complete bounded fixture passes', (context) => {
  const required = [
    'tests/extensions/canaries is missing; the SDK canary measured nothing',
    'tests/extensions/canaries contains no bundle directories',
  ].join('\n# ');
  const root = fixture({
    'sdk-canary.yml': `# ${required}\njobs:\n  canary:\n    timeout-minutes: 1\n`,
    'test.yml': '# Assert the census target contains runnable tests\njobs:\n  gate:\n    timeout-minutes: 1\n',
    'determinism.yml': '# Assert native determinism targets contain runnable tests\njobs:\n  gate:\n    timeout-minutes: 1\n',
    'python-wheels.yml': '# Assert the complete wheel matrix arrived\njobs:\n  wheel:\n    timeout-minutes: 1\n    steps:\n      - uses: actions/upload-artifact@sha\n        with:\n          path: dist/*.whl\n',
  });
  context.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(auditRoot(root), [
    '.github/workflows/python-wheels.yml: wheel upload does not fail when its artifact is absent',
  ]);
  const path = join(root, '.github', 'workflows', 'python-wheels.yml');
  writeFileSync(path, `${readFileSync(path, 'utf8')}          if-no-files-found: error\n`);
  assert.deepEqual(auditRoot(root), []);
});
