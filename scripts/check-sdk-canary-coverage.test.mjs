/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Executable proof that `scripts/check-sdk-canary-coverage.mjs` cannot pass
 * vacuously, and that it actually fires on the shape of #3452: a
 * `paths:` filter that names the direct build targets but not their
 * transitive workspace dependencies.
 *
 * Built against a synthetic tree (`--root`) so these assertions do not move
 * when the real workspace graph does, and so a fixture can reintroduce the
 * exact hole #3452 found (a `devDependency`-only transitive package left
 * uncovered) without waiting for the real graph to grow one again.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECK = join(HERE, 'check-sdk-canary-coverage.mjs');

function run(root) {
  try {
    const out = execFileSync(process.execPath, [CHECK, '--root', root], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, out };
  } catch (err) {
    return { status: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

function withTree(fn) {
  const root = mkdtempSync(join(tmpdir(), 'sdk-canary-coverage-'));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writePkg(root, name, deps = {}, devDeps = {}) {
  const dir = join(root, 'packages', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: `@t/${name}`, dependencies: deps, devDependencies: devDeps }),
  );
}

const WORKFLOW = (paths, filters = '@t/cli') => `name: SDK canary

on:
  pull_request:
    branches: [main]
${paths === null ? '' : `    paths:\n${paths.map((p) => `      - '${p}'`).join('\n')}\n`}
jobs:
  canary:
    runs-on: ubuntu-latest
    steps:
      - name: Build
        run: pnpm turbo build ${filters
          .split(',')
          .map((f) => `--filter=${f}`)
          .join(' ')}
`;

function writeWorkflow(root, text) {
  const dir = join(root, '.github/workflows');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'sdk-canary.yml'), text);
}

test('a package reachable only through a devDependency, and left out of paths, fails by name', () => {
  withTree((root) => {
    // cli -> mid (dependency) -> leaf (devDependency of mid, the shape
    // `timing-ladder`/`world-frame-fixtures` actually take in the real repo).
    writePkg(root, 'cli', { '@t/mid': 'workspace:^' });
    writePkg(root, 'mid', {}, { '@t/leaf': 'workspace:^' });
    writePkg(root, 'leaf');
    writeWorkflow(root, WORKFLOW(['packages/cli/**', 'packages/mid/**']));
    const { status, out } = run(root);
    assert.equal(status, 1);
    assert.match(out, /@t\/leaf/);
    assert.match(out, /packages\/leaf/);
  });
});

test('widening paths to cover the full closure turns it green', () => {
  withTree((root) => {
    writePkg(root, 'cli', { '@t/mid': 'workspace:^' });
    writePkg(root, 'mid', {}, { '@t/leaf': 'workspace:^' });
    writePkg(root, 'leaf');
    writeWorkflow(root, WORKFLOW(['packages/cli/**', 'packages/mid/**', 'packages/leaf/**']));
    const { status, out } = run(root);
    assert.equal(status, 0);
    assert.match(out, /covers all 3 package/);
  });
});

test('multiple --filter build targets are all walked', () => {
  withTree((root) => {
    writePkg(root, 'cli', { '@t/shared': 'workspace:^' });
    writePkg(root, 'extensions', { '@t/other': 'workspace:^' });
    writePkg(root, 'shared');
    writePkg(root, 'other');
    writeWorkflow(
      root,
      WORKFLOW(['packages/cli/**', 'packages/extensions/**'], '@t/cli,@t/extensions'),
    );
    const { status, out } = run(root);
    assert.equal(status, 1);
    assert.match(out, /@t\/shared/);
    assert.match(out, /@t\/other/);
  });
});

test('no path filter at all (paths absent) passes trivially -- everything reaches the job', () => {
  withTree((root) => {
    writePkg(root, 'cli', { '@t/mid': 'workspace:^' });
    writePkg(root, 'mid');
    writeWorkflow(root, WORKFLOW(null));
    const { status, out } = run(root);
    assert.equal(status, 0);
    assert.match(out, /no path filter/);
  });
});

test('a closure member with no matching workspace package fails closed, not silently short', () => {
  withTree((root) => {
    // cli depends on a package that does not exist under packages/*.
    writePkg(root, 'cli', { '@t/ghost': 'workspace:^' });
    writeWorkflow(root, WORKFLOW(['packages/cli/**']));
    const { status, out } = run(root);
    assert.equal(status, 1);
    assert.match(out, /@t\/ghost/);
    assert.match(out, /not a package name found/);
  });
});

test('a missing workflow file fails closed', () => {
  withTree((root) => {
    writePkg(root, 'cli');
    const { status, out } = run(root);
    assert.equal(status, 1);
    assert.match(out, /cannot read/);
  });
});

test('a turbo build step with no --filter= arguments fails closed', () => {
  withTree((root) => {
    writePkg(root, 'cli');
    writeWorkflow(
      root,
      `name: SDK canary

on:
  pull_request:
    branches: [main]
    paths:
      - 'packages/cli/**'

jobs:
  canary:
    runs-on: ubuntu-latest
    steps:
      - name: Build
        run: pnpm turbo build
`,
    );
    const { status, out } = run(root);
    assert.equal(status, 1);
    assert.match(out, /no --filter=<pkg> arguments/);
  });
});
