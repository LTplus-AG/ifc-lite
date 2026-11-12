/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The WASM build cache as the workflows actually wire it: each Plan and
 * Resolve step's `run:` line, taken from the shipped workflow and executed
 * the way the runner does, with $GITHUB_OUTPUT pointing at a file.
 *
 * The defect this pins: both steps once ran `... >> "$GITHUB_OUTPUT"`, so
 * the script's `::warning` lines landed in the output file as a bogus output
 * and were never shown as annotations, which is what a shadow rollout reads.
 * Here an annotation must reach stdout and the output file must parse by the
 * runner's rules. The same run also proves Plan accepts the shipped build
 * step (scripts/lib/ci-wasm-build-step.mjs).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INPUTS_FILE } from './lib/wasm-build-inputs.mjs';
import { BASE_ENV, REPO_ENV, commit, makeScriptRepo } from './lib/ci-wasm-cache-fixture.mjs';

/**
 * Parse a $GITHUB_OUTPUT file by the runner's rules: `name=value`, or a
 * `name<<DELIM` heredoc, with identifier names. Any other line fails: it is
 * what an annotation looks like after a redirect.
 */
function parseGithubOutput(text) {
  const out = {};
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (let i = 0; i < lines.length; i += 1) {
    const heredoc = lines[i].match(/^([A-Za-z_][\w-]*)<<(\S+)$/);
    if (heredoc) {
      const end = lines.indexOf(heredoc[2], i + 1);
      assert.ok(end > i, `unterminated heredoc ${heredoc[1]}`);
      out[heredoc[1]] = lines.slice(i + 1, end).join('\n');
      i = end;
      continue;
    }
    const pair = lines[i].match(/^([A-Za-z_][\w-]*)=(.*)$/);
    assert.ok(pair, `not a step output line: ${JSON.stringify(lines[i])}`);
    out[pair[1]] = pair[2];
  }
  return out;
}

/** Run a step's `run:` line under bash, as the runner does, with its own $GITHUB_OUTPUT. */
function runStep(root, line, env) {
  const dir = mkdtempSync(join(tmpdir(), 'wasm-cache-output-'));
  const outputFile = join(dir, 'output');
  writeFileSync(outputFile, '');
  try {
    const res = spawnSync('bash', ['-e', '-c', line], {
      cwd: root,
      encoding: 'utf-8',
      env: { PATH: process.env.PATH, ...REPO_ENV, ...env, GITHUB_OUTPUT: outputFile },
    });
    return { ...res, outputs: parseGithubOutput(readFileSync(outputFile, 'utf-8')) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The single-line `run:` of the step called `name`; executed, never asserted on. */
function runLineOf(workflowText, name) {
  const lines = workflowText.split('\n');
  const at = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  assert.ok(at >= 0, `no step named ${name}`);
  const run = lines.slice(at + 1).find((line) => /^\s*run: /.test(line));
  return run.trim().slice('run: '.length);
}

for (const workflow of ['test.yml', 'wasm-build-cache.yml']) {
  test(`${workflow}: Plan and Resolve as wired keep outputs valid and annotations visible`, () => {
    const root = makeScriptRepo({ workflows: true });
    const temp = mkdtempSync(join(tmpdir(), 'wasm-cache-temp-'));
    try {
      const text = readFileSync(join(root, '.github', 'workflows', workflow), 'utf-8');
      const plan = runLineOf(text, 'Plan the WASM build cache');
      const resolve = runLineOf(text, 'Resolve the WASM build');
      const env = {
        ...BASE_ENV,
        CI_WASM_CACHE: 'on',
        GITHUB_EVENT_NAME: 'pull_request',
        PR_BATCH: 'false',
        GITHUB_WORKFLOW_REF: `o/r/.github/workflows/${workflow}@refs/pull/1/merge`,
        RUNNER_TEMP: temp,
      };

      const planned = runStep(root, plan, env);
      assert.equal(planned.status, 0, planned.stderr);
      // Plan accepts the shipped build step and produces a key.
      assert.equal(planned.outputs.active, 'true', `Plan turned the cache off: ${planned.stdout}`);
      assert.equal(planned.stdout, '', 'a clean plan annotates nothing');

      // No manifest was restored, so this claimed hit is rejected: its warning
      // must reach the log, and the outputs must still parse.
      const resolved = runStep(root, resolve, {
        ...env,
        WASM_CACHE_MODE: 'on',
        WASM_CACHE_VERIFY: 'false',
        WASM_CACHE_STORE: 'true',
        WASM_CACHE_HIT: 'true',
        WASM_CACHE_KEY: planned.outputs.key,
      });
      assert.deepEqual(resolved.outputs, { build: 'true', compare: 'false', save: 'false', rejected: 'true' });
      assert.ok(resolved.stdout.startsWith('::warning title=WASM build cache entry rejected::'), resolved.stdout);

      commit(root, INPUTS_FILE, 'rustXX\n');
      const typo = runStep(root, plan, env);
      assert.deepEqual(typo.outputs, { mode: 'on', active: 'false', verify: 'false' });
      assert.ok(typo.stdout.startsWith('::warning title=WASM build cache off for this run::'), typo.stdout);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(temp, { recursive: true, force: true });
    }
  });
}
