/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * How `.mergify.yml` routes PRs into its queues: one PR per check everywhere,
 * ceiling PRs (#8459) and the Version Packages PR in queues of their own, and
 * nothing queued before it is ready. The `.mergify.yml` header says why.
 *
 * The config is evaluated rather than grepped: a minimal evaluator for the
 * condition forms `.mergify.yml` uses, which throws on any other form, so a
 * new condition cannot silently read as "matches".
 *
 * Run: node --test scripts/perf-ratchet/merge-queue.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const cfg = parse(readFileSync(join(REPO_ROOT, '.mergify.yml'), 'utf8'));
const CEILING_FILES = readdirSync(join(REPO_ROOT, 'tests/perf-ratchets'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => `tests/perf-ratchets/${f}`);

/** @param {string} cond @param {{ labels: string[], draft: boolean, files: string[], head: string, statuses: string[], unresolvedThreads: number }} pr */
function matches(cond, pr) {
  // @source-text-assertion-ok subject is the parsed config, evaluated as conditions
  const [, negated, kind, arg] = /^(-?)(draft$|label=|files~=|head=|status-success=|check-success=|#review-threads-unresolved=)(.*)$/.exec(cond) ?? [];
  if (!kind) throw new Error(`merge-queue.test.mjs cannot evaluate Mergify condition ${JSON.stringify(cond)}; teach matches() its meaning`);
  const hit = {
    draft: () => pr.draft,
    // @source-text-assertion-ok subject is the parsed config, evaluated as conditions
    'label=': () => pr.labels.includes(arg),
    // @source-text-assertion-ok subject is the parsed config, evaluated as conditions
    'files~=': () => pr.files.some((f) => new RegExp(arg).test(f)),
    'head=': () => pr.head === arg,
    'status-success=': () => pr.statuses.includes(arg),
    'check-success=': () => pr.statuses.includes(arg),
    '#review-threads-unresolved=': () => pr.unresolvedThreads === Number(arg),
  }[kind]();
  return negated ? !hit : hit;
}
const all = (conds, pr) => conds.every((c) => matches(c, pr));

/** The queue a PR is routed to, asserting the routing is unambiguous. */
function queueFor(pr) {
  const rules = cfg.pull_request_rules.filter((r) => r.actions?.queue && all(r.conditions, pr));
  const queues = cfg.queue_rules.filter((q) => all(q.queue_conditions, pr));
  if (rules.length === 0 && queues.length === 0) return null;
  assert.equal(rules.length, 1, `exactly one pull_request_rule queues ${JSON.stringify(pr.files)}`);
  assert.equal(queues.length, 1, `exactly one queue admits ${JSON.stringify(pr.files)}`);
  // A routing rule naming a queue whose own queue_conditions reject the PR
  // would leave it bouncing in and out of the queue.
  assert.equal(rules[0].actions.queue.name, queues[0].name, 'the routing rule names the queue that admits the PR');
  return queues[0];
}
const READY = ['CLA', 'PR review signal'];
const pr = (files, extra = {}) => ({ labels: ['mergify-trial'], draft: false, files, head: 'feature/x', statuses: READY, unresolvedThreads: 0, ...extra });
const RELEASE = 'changeset-release/main';

test('a lowering PR like #8459 goes to the ceilings queue, for every committed ceiling family', () => {
  assert.ok(CEILING_FILES.length > 0, 'tests/perf-ratchets holds ceiling files');
  for (const file of CEILING_FILES) {
    assert.equal(queueFor(pr([file])).name, 'ceilings', file);
  }
  assert.equal(queueFor(pr(CEILING_FILES)).name, 'ceilings', 'all families at once, as the daily job can propose');
});

test('a code PR that also edits a ceiling goes to the ceilings queue too', () => {
  assert.equal(queueFor(pr(['apps/viewer/src/main.tsx', 'tests/perf-ratchets/bundle.json'])).name, 'ceilings');
});

test('ordinary PRs are queued one at a time too; drafts and unlabelled PRs are not queued', () => {
  // The Mergify plan refuses batch_size above 1 (#10506): any queue above it stops every queue.
  for (const q of cfg.queue_rules) assert.equal(q.batch_size ?? 1, 1, q.name);
  assert.equal(queueFor(pr(['apps/viewer/src/main.tsx'])).name, 'default');
  assert.equal(queueFor(pr(['scripts/perf-ratchet/lower.mjs'])).name, 'default', 'the ratchet scripts are code, not ceilings');
  assert.equal(queueFor(pr(['tests/perf-ratchets/bundle.json'], { draft: true })), null);
  assert.equal(queueFor(pr(['tests/perf-ratchets/bundle.json'], { labels: [] })), null);
});

test('the Version Packages PR has its own queue, apart from PRs carrying changesets (#8630)', () => {
  const release = queueFor(pr(['.changeset/x.md', 'packages/parser/package.json', 'Cargo.toml'], { head: RELEASE }));
  assert.equal(release.name, 'release');
  assert.equal(queueFor(pr(['tests/perf-ratchets/bundle.json'], { head: RELEASE })).name, 'release', 'even if it ever touches a ceiling');
  assert.notEqual(queueFor(pr(['.changeset/x.md'])).name, 'release', 'a PR adding a changeset is ordinary work');
  assert.equal(queueFor(pr(['Cargo.toml'], { head: RELEASE, draft: true })), null, 'a stale, drafted release leaves the queue');
});

test('the Version Packages PR goes first, interrupting checks, so it is tested on main itself', () => {
  const rules = (cfg.priority_rules ?? []).filter((r) => all(r.conditions, pr(['Cargo.toml'], { head: RELEASE })));
  assert.equal(rules.length, 1);
  assert.equal(rules[0].allow_checks_interruption, true);
  const top = Math.max(...(cfg.priority_rules ?? []).map((r) => (typeof r.priority === 'number' ? r.priority : 0)));
  assert.equal(rules[0].priority, top, 'no rule outranks the release');
  assert.equal((cfg.priority_rules ?? []).filter((r) => all(r.conditions, pr(['x.ts']))).length, 0, 'ordinary PRs get no priority');
});

test('the ceilings queue is not a weaker gate: every queue requires the same full-lane checks', () => {
  const [first, ...rest] = cfg.queue_rules;
  assert.ok(first.merge_conditions.length > 0);
  for (const q of rest) assert.deepEqual(q.merge_conditions, first.merge_conditions, q.name);
});

test('no queue admits a PR whose CLA status is not green, so queue PRs only carry signed work', () => {
  for (const files of [['apps/viewer/src/main.tsx'], ['tests/perf-ratchets/bundle.json']]) {
    assert.equal(queueFor(pr(files, { statuses: [] })), null, JSON.stringify(files));
  }
  assert.equal(queueFor(pr(['Cargo.toml'], { head: RELEASE, statuses: [] })), null, 'the release PR too');
});

test('a labelled PR waits outside the queue until its review gate is green and its threads are resolved', () => {
  for (const files of [['apps/viewer/src/main.tsx'], ['tests/perf-ratchets/bundle.json']]) {
    assert.ok(queueFor(pr(files)), 'ready: queued');
    assert.equal(queueFor(pr(files, { statuses: ['CLA'] })), null, 'PR review signal not green yet');
    assert.equal(queueFor(pr(files, { unresolvedThreads: 2 })), null, 'review threads still open');
  }
});
