/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * The gate is only worth having if it goes RED on the shape it exists to catch,
 * so every case here is a positive control: a synthetic workflow carrying the
 * defect, asserted to be reported. The last case pins the real file.
 */
/* eslint-disable no-template-curly-in-string -- the strings under test ARE
 * GitHub Actions expressions (`${{ needs.<job>.result }}`); they must stay
 * literal, and a template literal would interpolate them away. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readAggregate, unjudged, unreachable, prJobs, unwatched, UNJUDGED_BY_DESIGN } from './check-ci-aggregate-coverage.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const workflow = (needs, judged) => `on: [push]
jobs:
  changes:
    name: Detect changes
    runs-on: ubuntu-latest
  test:
    name: Build + WASM + Rust + Node
    needs: [${needs.join(', ')}]
    if: always()
    runs-on: ubuntu-latest
    steps:
      - name: Gate on dependencies
        run: |
          declare -A results=(
${judged.map((j) => `            [${j}]="\${{ needs.${j}.result }}"`).join('\n')}
          )
          exit $fail
`;

test('RED: a job in needs but absent from the map is reported unjudged', () => {
  const agg = readAggregate(workflow(['changes', 'build'], ['build']));
  assert.deepEqual(unjudged(agg), ['changes']);
});

test('RED: this is the exact #4144 shape — changes unjudged while every lane needs it', () => {
  const agg = readAggregate(workflow(['changes', 'build', 'lint'], ['build', 'lint']));
  assert.ok(unjudged(agg).includes('changes'));
});

test('RED: a map entry naming a job not in needs is reported unreachable', () => {
  const agg = readAggregate(workflow(['build'], ['build', 'ghost']));
  assert.deepEqual(unreachable(agg), ['ghost']);
});

test('GREEN: a fully covered aggregate reports nothing', () => {
  const agg = readAggregate(workflow(['changes', 'build'], ['changes', 'build']));
  assert.deepEqual(unjudged(agg), []);
  assert.deepEqual(unreachable(agg), []);
});

test('the parser survives `$` under the m flag, which truncated the body to one line', () => {
  // The first draft used `(?=\n  \S|$)`. With /m, `$` matches at every line end,
  // so the lazy body stopped after `name:` and a job with fourteen dependencies
  // reported `needs: []` — a vacuous pass dressed as a parse.
  const agg = readAggregate(workflow(['a', 'b', 'c'], ['a']));
  assert.equal(agg.needs.length, 3, 'body must span past the first newline');
});

test('RED: a row whose bracket key and interpolation disagree is reported', () => {
  // The likeliest way to add a lane wrong: copy the row above, edit the bracket,
  // forget the right-hand side. Checking only the key called this full coverage.
  const text = workflow(['changes', 'build'], ['changes', 'build']).replace(
    '[build]="${{ needs.build.result }}"',
    '[build]="${{ needs.changes.result }}"'
  );
  const agg = readAggregate(text);
  assert.deepEqual(agg.mismatched, [{ key: 'build', reads: 'changes' }]);
});

test('RED: a duplicated bracket key is reported, not deduped away', () => {
  // bash keeps the LAST assignment, so an earlier duplicate row is dead code and
  // the "N judged" count overstates coverage.
  const text = workflow(['changes', 'build'], ['changes', 'build', 'build']);
  const agg = readAggregate(text);
  assert.deepEqual(agg.duplicated, ['build']);
});

test('a single-quoted map value is accepted, not read as zero coverage', () => {
  // `[job]='${{ ... }}'` is valid bash and valid interpolation. Requiring `"`
  // made a legal map parse as no entries: fail-closed, but the remedy text sent
  // you hunting a coverage hole that did not exist.
  const text = workflow(['build'], ['build']).replace(
    '[build]="${{ needs.build.result }}"',
    "[build]='${{ needs.build.result }}'"
  );
  const agg = readAggregate(text);
  assert.deepEqual(agg.judged, ['build']);
  assert.deepEqual(unjudged(agg), []);
});

test('RED: a PR-reachable job outside needs and outside the exemptions is reported', () => {
  const text = `on: [pull_request]
jobs:
  changes:
    runs-on: ubuntu-latest
  stray:
    name: Stray lane
    needs: changes
    runs-on: ubuntu-latest
  test:
    needs: [changes]
    runs-on: ubuntu-latest
    steps:
      - run: |
          declare -A results=(
            [changes]="\${{ needs.changes.result }}"
          )
`;
  assert.deepEqual(unwatched(text, readAggregate(text)), ['stray']);
});

test('prJobs reads the jobs: block only, not the on: trigger keys', () => {
  // A naive `^  name:$` sweep of the whole file also matches `push:` and
  // `pull_request:` under the top-level `on:`, which made an ad-hoc probe
  // report a job that does not exist.
  const text = `on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
jobs:
  real:
    runs-on: ubuntu-latest
`;
  assert.deepEqual(prJobs(text), ['real']);
});

test('every exemption carries a stated reason', () => {
  // An exemption is a decision. One with no reason is an oversight wearing a
  // decision's clothes, and this list is meant to ratchet down.
  for (const [job, reason] of Object.entries(UNJUDGED_BY_DESIGN)) {
    assert.ok(typeof reason === 'string' && reason.length > 40, `${job} needs a real reason`);
  }
});

test('the real test.yml aggregate is fully covered', () => {
  const text = readFileSync(join(ROOT, '.github/workflows/test.yml'), 'utf8');
  const agg = readAggregate(text);
  assert.ok(agg, 'the `test:` job must be findable by name');
  assert.ok(agg.needs.length > 5, `expected a real needs list, got ${agg.needs.length}`);
  assert.ok(agg.needs.includes('changes'), 'the path-filter job must be a dependency');
  assert.deepEqual(unjudged(agg), [], 'every dependency must be judged');
  assert.deepEqual(unreachable(agg), [], 'every judgement must name a dependency');
  assert.deepEqual(agg.mismatched, [], 'every row must judge the job it names');
  assert.deepEqual(agg.duplicated, [], 'no job may be judged twice');
});
