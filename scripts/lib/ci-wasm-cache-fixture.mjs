/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Temp git repos for scripts/ci-wasm-cache*.test.mjs: a repo shaped like the
 * WASM build inputs, optionally carrying its own copy of ci-wasm-cache.mjs so
 * the CLI keys on that repo.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INPUTS_FILE } from './wasm-build-inputs.mjs';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The scripts/lib modules ci-wasm-cache.mjs imports, for copying it into a temp repo. */
export const CACHE_SCRIPT_LIBS = ['is-main-entry.mjs', 'ci-wasm-build-step.mjs', 'wasm-build-inputs.mjs', 'ci-wasm-key-env.mjs'];

export const BASE_ENV = { RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64', HOME: '/home/runner' };

export function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' });
}

export function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'wasm-cache-'));
  mkdirSync(join(root, 'rust', 'core'), { recursive: true });
  mkdirSync(join(root, 'packages', 'wasm', 'pkg'), { recursive: true });
  writeFileSync(join(root, 'rust', 'core', 'lib.rs'), 'pub fn f() {}\n');
  writeFileSync(join(root, 'Cargo.lock'), 'lock v1\n');
  writeFileSync(join(root, 'packages', 'wasm', 'pkg', 'ifc-lite.d.ts'), 'committed\n');
  git(root, 'init', '-q', '.');
  git(root, 'config', 'user.email', 'harness@example.invalid');
  git(root, 'config', 'user.name', 'harness');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  return root;
}

export function commit(root, file, content) {
  writeFileSync(join(root, file), content);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', `edit ${file}`);
}

export const REPO_ROOT = join(SCRIPTS, '..');
export const REPO_ENV = {
  GITHUB_REPOSITORY: 'o/r',
  GITHUB_WORKFLOW_REF: 'o/r/.github/workflows/test.yml@refs/pull/1/merge',
};
export const KEYABLE_WORKFLOW = `jobs:
  build:
    steps:
      - name: Build WASM (cache active)
        if: always()
        run: bash scripts/ci-wasm-build.sh
`;

/**
 * A temp repo carrying its own copy of the script, so the CLI keys on it.
 * `workflows` copies the real workflow files in instead of the stub.
 */
export function makeScriptRepo({ workflows = false } = {}) {
  const root = makeRepo();
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  copyFileSync(join(SCRIPTS, 'ci-wasm-cache.mjs'), join(root, 'scripts', 'ci-wasm-cache.mjs'));
  for (const lib of CACHE_SCRIPT_LIBS) {
    copyFileSync(join(SCRIPTS, 'lib', lib), join(root, 'scripts', 'lib', lib));
  }
  writeFileSync(join(root, INPUTS_FILE), '# test list\nrust\nCargo.lock\n');
  if (workflows) {
    for (const file of ['test.yml', 'wasm-build-cache.yml']) {
      copyFileSync(join(REPO_ROOT, '.github', 'workflows', file), join(root, '.github', 'workflows', file));
    }
  } else {
    writeFileSync(join(root, '.github', 'workflows', 'test.yml'), KEYABLE_WORKFLOW);
  }
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'script');
  return root;
}
