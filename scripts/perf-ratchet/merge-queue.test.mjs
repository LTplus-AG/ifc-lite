/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A ceiling PR is merged only as the tip of a batch of one (#8459).
 *
 * Mergify tests a batch at its tip and then squashes each PR onto `main` as
 * its own commit. #8459 lowered `bundle/viewer-eager-js-bytes` to what main
 * measured at 6e42aaf3fde1; by the time it was queued, main had grown past
 * that ceiling plus its band. Batch #8497 caught it, but the retry batch #8501
 * also held #8411, which shrank eager JS by 1.8%, so the tip passed and
 * c306ff57d4 (#8459 alone on main) landed red. With batch_size 1 the commit
 * that lands is the commit that was tested.
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

/** @param {string} cond @param {{ labels: string[], draft: boolean, files: string[] }} pr */
function matches(cond, pr) {
  // @source-text-assertion-ok subject is the parsed config, evaluated as conditions
  const [, negated, kind, arg] = /^(-?)(draft$|label=|files~=)(.*)$/.exec(cond) ?? [];
  if (!kind) throw new Error(`merge-queue.test.mjs cannot evaluate Mergify condition ${JSON.stringify(cond)}; teach matches() its meaning`);
  const hit = {
    draft: () => pr.draft,
    // @source-text-assertion-ok subject is the parsed config, evaluated as conditions
    'label=': () => pr.labels.includes(arg),
    // @source-text-assertion-ok subject is the parsed config, evaluated as conditions
    'files~=': () => pr.files.some((f) => new RegExp(arg).test(f)),
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
const pr = (files, extra = {}) => ({ labels: ['mergify-trial'], draft: false, files, ...extra });

test('a lowering PR like #8459 is queued alone, for every committed ceiling family', () => {
  assert.ok(CEILING_FILES.length > 0, 'tests/perf-ratchets holds ceiling files');
  for (const file of CEILING_FILES) {
    assert.equal(queueFor(pr([file])).batch_size, 1, file);
  }
  assert.equal(queueFor(pr(CEILING_FILES)).batch_size, 1, 'all families at once, as the daily job can propose');
});

test('a code PR that also edits a ceiling is queued alone too', () => {
  assert.equal(queueFor(pr(['apps/viewer/src/main.tsx', 'tests/perf-ratchets/bundle.json'])).batch_size, 1);
});

test('ordinary PRs keep batching; drafts and unlabelled PRs are not queued', () => {
  assert.ok(queueFor(pr(['apps/viewer/src/main.tsx'])).batch_size > 1);
  assert.ok(queueFor(pr(['scripts/perf-ratchet/lower.mjs'])).batch_size > 1, 'the ratchet scripts are code, not ceilings');
  assert.equal(queueFor(pr(['tests/perf-ratchets/bundle.json'], { draft: true })), null);
  assert.equal(queueFor(pr(['tests/perf-ratchets/bundle.json'], { labels: [] })), null);
});

test('the ceilings queue is not a weaker gate: every queue requires the same full-lane checks', () => {
  const [first, ...rest] = cfg.queue_rules;
  assert.ok(first.merge_conditions.length > 0);
  for (const q of rest) assert.deepEqual(q.merge_conditions, first.merge_conditions, q.name);
});
