/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The release PR lean lane: the decision, the diff rule, the Mergify route
 * check, the aggregate's re-derivation, the CLI against a real git repo, and
 * the test.yml wiring.
 *
 * Run: node --test scripts/ci-release-lane.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

import {
  LEAN_CHECKS,
  LEAN_KEPT_JOBS,
  OWNER_ALLOWS_LEAN,
  QUEUE_FULL_CHECKS,
  RELEASE_HEAD_REF,
  decideReleaseLane,
  parsePullRequestRules,
  parseQueueRules,
  releaseQueueRoute,
  runLeanChecks,
  verifyReleaseLane,
} from './ci-release-lane.mjs';
import { diffProblems } from './lib/release-version-diff.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const CLI = join(HERE, 'ci-release-lane.mjs');
const MERGIFY = readFileSync(join(REPO_ROOT, '.mergify.yml'), 'utf8');
const WORKFLOW = parse(readFileSync(join(REPO_ROOT, '.github/workflows/test.yml'), 'utf8'));
const jobs = WORKFLOW.jobs;

const TMP = mkdtempSync(join(tmpdir(), 'ci-release-lane-'));
test.after(() => rmSync(TMP, { recursive: true, force: true }));

const BASE = {
  event: 'pull_request',
  mode: 'on',
  headRef: RELEASE_HEAD_REF,
  headRepo: 'o/r',
  repo: 'o/r',
  baseRef: 'main',
  labels: JSON.stringify(['mergify-trial']),
  draft: 'false',
  mergify: () => MERGIFY,
  diff: () => [],
  // The lean path itself; the shipped OWNER_ALLOWS_LEAN is pinned in its own test.
  ownerAllowsLean: true,
};
const decide = (over = {}) => decideReleaseLane({ ...BASE, ...over });

function needsJson(result = 'success', overrides = {}) {
  const out = {};
  for (const j of jobs.test.needs) out[j] = { result: overrides[j] ?? result, outputs: {} };
  return JSON.stringify(out);
}

// ---------------------------------------------------------------- the decision

test('unset and `off` are today\'s behaviour, and so is any unknown value', () => {
  for (const mode of [undefined, '', 'off', 'OFF']) assert.equal(decide({ mode }).lane, 'full', String(mode));
  for (const mode of ['true', 'lean', ' on', 'on ', 'fast']) {
    const d = decide({ mode });
    assert.equal(d.lane, 'full', JSON.stringify(mode));
    assert.equal(d.pending, undefined);
    assert.match(d.warning ?? '', /not one of off, shadow, on/); // @source-text-assertion-ok subject is the decision's returned message
  }
});

test('RELEASED (#9783): the owner released OWNER_ALLOWS_LEAN; false holds `on` back to reporting', () => {
  // A lean run turns the required aggregate green, and nothing in the repo
  // stops a direct merge of a PR with green required checks. The owner relies
  // on the `main` ruleset (2026-11-12); this pins the choice so changing it is
  // a reviewed diff.
  assert.equal(OWNER_ALLOWS_LEAN, true);
  const { ownerAllowsLean: _ignored, ...shipped } = BASE;
  assert.equal(decideReleaseLane(shipped).lane, 'lean');
  const held = { ...BASE, ownerAllowsLean: false };
  const d = decideReleaseLane(held);
  assert.equal(d.lane, 'full');
  assert.ok(d.pending, 'still reported, like shadow');
  assert.match(d.warning ?? '', /held/); // @source-text-assertion-ok subject is the decision's returned message
  const v = verifyReleaseLane({ ...held, lane: 'lean', needs: needsJson() });
  assert.equal(v.ok, false, 'a lean output while held is unjustified');
});

test('`on` gives the release PR the lean lane; `shadow` runs full and records it', () => {
  assert.equal(decide().lane, 'lean');
  assert.equal(decide({ mode: 'On' }).lane, 'lean', 'case-insensitive like Actions `==`');
  const s = decide({ mode: 'shadow' });
  assert.equal(s.lane, 'full');
  assert.ok(s.pending);
});

test('REFUSE: only a same-repo pull_request from changeset-release/main into main', () => {
  const cases = [
    { headRef: 'changeset-release/main-2' },
    { headRef: 'feature/changeset-release/main' },
    { headRef: undefined },
    { headRepo: 'fork/r' },
    { headRepo: undefined },
    { repo: undefined, headRepo: undefined },
    { baseRef: 'release/1.x' },
    { event: 'merge_group' },
    { event: 'push' },
    { event: 'pull_request_target' },
    { event: undefined },
  ];
  for (const c of cases) {
    for (const mode of ['on', 'shadow']) {
      const d = decide({ ...c, mode });
      assert.equal(d.lane, 'full', JSON.stringify(c));
      assert.equal(d.pending, undefined, JSON.stringify(c));
    }
  }
});

test('REFUSE: no full-gate Mergify route for the release PR means this run is the gate', () => {
  const noRoute = MERGIFY.replace(/- head=changeset-release\/main\n/g, '- head=other\n');
  assert.equal(decide({ mergify: () => noRoute }).lane, 'full');
  for (const check of QUEUE_FULL_CHECKS) {
    const weak = MERGIFY.replace(new RegExp(`\\n\\s+- ${check.replace(/[+()]/g, '\\$&')}`, 'g'), '');
    const d = decide({ mergify: () => weak });
    assert.equal(d.lane, 'full', check);
    assert.ok(d.warning, 'a refused route is announced');
  }
  assert.equal(decide({ mergify: () => { throw new Error('ENOENT'); } }).lane, 'full');
  assert.equal(decide({ mergify: () => '' }).lane, 'full');
});

test('REFUSE: the PR must meet the release queue\'s entry conditions now (label, not a draft)', () => {
  // #8761 carried no labels: Mergify would never queue it, so nothing would
  // run its full lanes before a merge.
  for (const labels of ['[]', '["unqueued"]', 'null', 'garbage', '[1]']) {
    const d = decide({ labels });
    assert.equal(d.lane, 'full', labels);
    assert.equal(d.pending, undefined, labels);
  }
  for (const draft of ['true', '', undefined]) assert.equal(decide({ draft }).lane, 'full', String(draft));
});

test('SHADOW measures whatever the PR\'s queue state: an unlabelled or draft release PR is still reported (#9783 review)', () => {
  // The open release PR carries no labels, so a shadow that needed
  // `mergify-trial` reported nothing at all. It reports, and says why the PR
  // is not queueable; the lean decision itself still refuses.
  // The hold is passed explicitly, so this pins shadow and held `on`, not the constant's value.
  const held = { ...BASE, ownerAllowsLean: false };
  for (const over of [{ labels: '[]' }, { draft: 'true' }, { labels: '[]', draft: 'true' }]) {
    for (const mode of ['shadow', 'on']) {
      const d = decideReleaseLane({ ...held, ...over, mode });
      assert.equal(d.lane, 'full', `${mode} ${JSON.stringify(over)}`);
      assert.ok(d.pending, `${mode} ${JSON.stringify(over)}`);
      assert.match(d.reason, /will not take this PR yet/); // @source-text-assertion-ok subject is the decision's returned reason
    }
  }
  const v = verifyReleaseLane({ ...held, mode: 'shadow', labels: '[]', lane: 'full', needs: needsJson('success', { 'viewer-tests': 'failure' }) });
  assert.equal(v.ok, true);
  // Not queueable: the report is conditional, never a claim about today.
  assert.match(v.lines.join('\n'), /The lean lane \(with CI_RELEASE_LANE=on, with OWNER_ALLOWS_LEAN released, once this PR is queueable\) would defer a failure to the merge queue: viewer-tests/); // @source-text-assertion-ok subject is the returned summary
  assert.match(v.lines.join('\n'), /lacks `mergify-trial`/); // @source-text-assertion-ok subject is the returned summary
  const queueable = verifyReleaseLane({ ...held, mode: 'shadow', lane: 'full', needs: needsJson() });
  assert.match(queueable.lines.join('\n'), /Lanes that ran here and the lean lane \(with CI_RELEASE_LANE=on, with OWNER_ALLOWS_LEAN released\) would skip:/); // @source-text-assertion-ok subject is the returned summary
  // Every pending condition is named by the decision, for each way a PR can be unqueueable.
  const pendingOf = (over) => decideReleaseLane({ ...held, ...over }).pending;
  assert.deepEqual(pendingOf({ mode: 'shadow', ownerAllowsLean: true }), ['with CI_RELEASE_LANE=on']);
  assert.deepEqual(pendingOf({ mode: 'shadow', labels: '[]' }), ['with CI_RELEASE_LANE=on', 'with OWNER_ALLOWS_LEAN released', 'once this PR is queueable']);
  assert.deepEqual(pendingOf({ mode: 'on', labels: '[]' }), ['with OWNER_ALLOWS_LEAN released', 'once this PR is queueable']);
  assert.deepEqual(pendingOf({ mode: 'on', draft: 'true' }), ['with OWNER_ALLOWS_LEAN released', 'once this PR is queueable']);
  // Released `on`, unqueueable: refused outright, and the message names what is pending.
  for (const [over, why] of [[{ labels: '[]' }, /lacks `mergify-trial`/], [{ draft: 'true' }, /is a draft/]]) {
    const refused = decideReleaseLane({ ...held, mode: 'on', ownerAllowsLean: true, ...over });
    assert.equal(refused.lane, 'full', JSON.stringify(over));
    assert.equal(refused.pending, undefined);
    assert.equal(refused.warning, 'release lane refused; still pending: once this PR is queueable');
    assert.match(refused.reason, why); // @source-text-assertion-ok subject is the decision's returned reason
  }
  // Lean is exactly "nothing pending": the released, queueable `on` case.
  const lean = decideReleaseLane({ ...held, mode: 'on', ownerAllowsLean: true });
  assert.equal(lean.lane, 'lean');
  assert.equal(lean.pending, undefined);
  // Held `on` names the hold, and the queue state when it applies; never a claim about today.
  const heldOn = (labels, needs) => verifyReleaseLane({ ...held, mode: 'on', labels, lane: 'full', needs }).lines.join('\n');
  assert.match(heldOn('["mergify-trial"]', needsJson()), /None of them failed\. The lean lane \(with OWNER_ALLOWS_LEAN released\) would reach the same verdict/); // @source-text-assertion-ok subject is the returned summary
  assert.match(heldOn('[]', needsJson('success', { 'viewer-tests': 'failure' })), /The lean lane \(with OWNER_ALLOWS_LEAN released, once this PR is queueable\) would defer a failure/); // @source-text-assertion-ok subject is the returned summary
  // A config that cannot route the PR, or a diff that is more than versions, is still not reported as lean.
  assert.equal(decideReleaseLane({ ...held, mode: 'shadow', labels: '[]', mergify: () => '' }).pending, undefined);
  assert.equal(decideReleaseLane({ ...held, mode: 'shadow', labels: '[]', diff: () => ['x: not a release file'] }).pending, undefined);
});

test('REFUSE: a queue Mergify could check in place, or an entry condition this script cannot judge', () => {
  // Mergify judges the PR's own run (in place, or merges without a draft)
  // only for single-step CI: merge_conditions empty or equal to the queue's.
  const rule = parseQueueRules(MERGIFY).find((r) => r.name === 'release');
  const singleStep = `queue_rules:\n  - name: release\n    queue_conditions:\n${[...rule.queue, ...QUEUE_FULL_CHECKS].map((c) => `      - ${c}`).join('\n')}\n    merge_conditions:\n${[...rule.queue, ...QUEUE_FULL_CHECKS].map((c) => `      - ${c}`).join('\n')}\n`;
  assert.match(releaseQueueRoute(singleStep, { labels: ['mergify-trial'], draft: false }).reason, /single-step/); // @source-text-assertion-ok subject is the returned reason
  const unknown = MERGIFY.replace('      - head=changeset-release/main\n    merge_conditions', '      - head=changeset-release/main\n      - base=main\n    merge_conditions');
  assert.notEqual(unknown, MERGIFY, 'the fixture edit applied');
  assert.match(releaseQueueRoute(unknown, { labels: ['mergify-trial'], draft: false }).reason, /cannot judge: base=main/); // @source-text-assertion-ok subject is the returned reason
});

test('REFUSE: a diff that moves more than versions, or cannot be read, runs full', () => {
  assert.equal(decide({ diff: () => ['src/x.ts: not a release file'] }).lane, 'full');
  assert.equal(decide({ diff: () => { throw new Error('bad revision HEAD~1'); } }).lane, 'full');
  assert.equal(decide({ mode: 'shadow', diff: () => ['x'] }).pending, undefined);
});

test('the inputs are read only when the cheap checks pass (no git on an ordinary PR)', () => {
  const boom = () => { throw new Error('must not be read'); };
  for (const over of [{ mode: 'off' }, { headRef: 'feature' }, { event: 'push' }]) {
    assert.equal(decide({ ...over, mergify: boom, diff: boom }).lane, 'full');
  }
});

// ---------------------------------------------------------------- Mergify

test('the narrow queue-rule reader agrees with a YAML parse of the real .mergify.yml', () => {
  const real = parse(MERGIFY).queue_rules.map((r) => ({ name: r.name, queue: r.queue_conditions ?? [], merge: r.merge_conditions ?? [], unread: false }));
  assert.deepEqual(parseQueueRules(MERGIFY), real);
  const route = releaseQueueRoute(MERGIFY, { labels: ['mergify-trial'], draft: false });
  assert.equal(route.ok, true, route.reason);
  assert.equal(route.queueable, true, route.queueReason);
  const unlabelled = releaseQueueRoute(MERGIFY, { labels: [], draft: false });
  assert.equal(unlabelled.ok, true, 'a missing label is PR state, not a config refusal');
  assert.equal(unlabelled.queueable, false);
});

test('the narrow pull_request_rules reader agrees with a YAML parse of the real .mergify.yml', () => {
  const real = parse(MERGIFY).pull_request_rules.map((r) => ({ name: r.name, conditions: r.conditions ?? [], actions: Object.keys(r.actions ?? {}), queue: r.actions?.queue?.name ?? null, unread: false }));
  assert.deepEqual(parsePullRequestRules(MERGIFY), real);
});

test('REFUSE (#9783 review): no pull_request_rules entry queues the release PR into the release queue', () => {
  const rule = 'head=changeset-release/main\n    actions:\n      queue:\n        name: release';
  assert.ok(MERGIFY.includes(rule), 'fixture anchor');
  for (const [broken, why] of [
    [MERGIFY.replace(rule, 'head=changeset-release/main\n    actions:\n      queue:\n        name: default'), /can queue the release PR into `default`, not `release`/],
    [MERGIFY.replace(rule, 'head=changeset-release/other\n    actions:\n      queue:\n        name: release'), /no Mergify pull_request_rules entry queues/],
    [MERGIFY.slice(0, MERGIFY.indexOf('pull_request_rules:')), /no Mergify pull_request_rules entry queues/],
  ]) {
    assert.notEqual(broken, MERGIFY);
    const r = releaseQueueRoute(broken, { labels: ['mergify-trial'], draft: false });
    assert.equal(r.ok, false);
    assert.match(r.reason, why); // @source-text-assertion-ok subject is the returned reason
    assert.equal(decide({ mergify: () => broken }).lane, 'full');
  }
  // An entry condition it cannot judge refuses; one it can, and the PR lacks, is PR state.
  const odd = MERGIFY.replace(rule, 'head=changeset-release/main\n      - author=someone\n    actions:\n      queue:\n        name: release');
  assert.match(releaseQueueRoute(odd, { labels: ['mergify-trial'], draft: false }).reason, /cannot judge: author=someone/); // @source-text-assertion-ok subject is the returned reason
  const labelled = MERGIFY.replace(rule, 'head=changeset-release/main\n      - label=release-ok\n    actions:\n      queue:\n        name: release');
  const r = releaseQueueRoute(labelled, { labels: ['mergify-trial'], draft: false });
  assert.equal(r.ok, true);
  assert.equal(r.queueable, false);
  assert.match(r.queueReason, /lacks `release-ok`/); // @source-text-assertion-ok subject is the returned reason
  // Two entry rules: either one's gaps would do, so both are named as alternatives.
  const second = labelled.replace('pull_request_rules:\n', 'pull_request_rules:\n  - name: alt\n    conditions:\n      - head=changeset-release/main\n      - label=alt-ok\n    actions:\n      queue:\n        name: release\n\n');
  // A gap the queue rule already names is not repeated per entry rule.
  const both = releaseQueueRoute(second, { labels: [], draft: false }).queueReason;
  assert.match(both, /will not take this PR yet: it lacks `mergify-trial`, it lacks `alt-ok`, or it lacks `release-ok`$/); // @source-text-assertion-ok subject is the returned reason
  assert.equal(releaseQueueRoute(MERGIFY, { labels: [], draft: true }).queueReason.match(/mergify-trial/g).length, 1, 'the real config names each gap once');
  assert.equal(releaseQueueRoute(second, { labels: ['alt-ok', 'mergify-trial'], draft: false }).queueable, true, 'the queue rule itself also needs mergify-trial');
});

test('REFUSE (#9783 review): any other route that can queue or merge the release PR', () => {
  const extra = (r) => MERGIFY.replace('pull_request_rules:\n', `pull_request_rules:\n${r}\n`);
  const cases = [
    // a rule with no head condition can match the release PR
    ['  - name: any\n    conditions:\n      - label=go\n    actions:\n      queue:\n        name: default', /`any` can queue the release PR into `default`/],
    ['  - name: m\n    conditions:\n      - label=go\n    actions:\n      merge:\n        method: squash', /`m` can merge the release PR/],
    // a rule for the release head that merges, or routes elsewhere, or in a form this script cannot read
    ['  - name: direct\n    conditions:\n      - head=changeset-release/main\n    actions:\n      merge: {}', /`direct` can merge the release PR/],
    ['  - name: unknown-action\n    conditions:\n      - head=changeset-release/main\n    actions:\n      dequeue_and_merge: {}', /`unknown-action` can dequeue_and_merge the release PR/],
    // actions it cannot read, flow style or misindented, are a refusal, not "no actions"
    ['  - name: flow\n    conditions:\n      - label=go\n    actions: {merge: {}}', /`flow` has actions this script cannot read/],
    ['  - name: deep\n    conditions:\n      - label=go\n    actions:\n        queue:\n          name: default', /`deep` has (actions|lines) this script cannot read/],
    // a merge key next to a safe action, an alias, a rule not led by `name`, a mapping where a list belongs
    ['  - name: sneaky\n    conditions:\n      - label=go\n    actions:\n      comment:\n        message: hi\n      <<: *direct_merge', /`sneaky` has lines this script cannot read/],
    ['  - name: alias\n    conditions: *conds\n    actions:\n      comment:\n        message: hi', /`alias` has lines this script cannot read/],
    ['  - conditions:\n      - label=go\n    name: late\n    actions:\n      merge: {}', /`\(unnamed: - conditions:\)` has lines this script cannot read/],
    ['  - name: mapped\n    conditions:\n      or: [label=go]\n    actions:\n      comment:\n        message: hi', /`mapped` has lines this script cannot read/],
    ['  - name: other\n    conditions:\n      - head=changeset-release/main\n    actions:\n      queue:\n        name: default', /`other` can queue the release PR into `default`/],
    ['  - name: inline\n    conditions:\n      - head=changeset-release/main\n    actions:\n      queue: {name: release}', /`inline` can queue the release PR into a queue this script cannot read/],
  ];
  for (const [r, why] of cases) {
    const route = releaseQueueRoute(extra(r), { labels: ['mergify-trial'], draft: false });
    assert.equal(route.ok, false, r);
    assert.match(route.reason, why); // @source-text-assertion-ok subject is the returned reason
  }
  // A rule excluding the release head, or with no routing action, is no route.
  for (const r of ['  - name: ex\n    conditions:\n      - -head=changeset-release/main\n    actions:\n      queue:\n        name: default', '  - name: elsewhere\n    conditions:\n      - head=feature/x\n    actions:\n      merge: {}', '  - name: not-x\n    conditions:\n      - -head=feature/x\n      - label=go\n    actions:\n      queue:\n        name: release', '  - name: note\n    conditions:\n      - label=go\n    actions:\n      comment:\n        message: hi']) {
    assert.equal(releaseQueueRoute(extra(r), { labels: ['mergify-trial'], draft: false }).ok, true, r);
  }
  // Two queue rules taking the release head: the other could be single-step.
  const twoQueues = MERGIFY.replace('queue_rules:\n', 'queue_rules:\n  - name: release-fast\n    queue_conditions:\n      - head=changeset-release/main\n    merge_conditions:\n      - head=changeset-release/main\n');
  assert.match(releaseQueueRoute(twoQueues, { labels: ['mergify-trial'], draft: false }).reason, /more than one Mergify queue rule can take head=changeset-release\/main \(release-fast, release\)/); // @source-text-assertion-ok subject is the returned reason
  // A queue with no head condition can take it too (autoqueue, `@Mergifyio queue open`).
  const open = MERGIFY.replace('queue_rules:\n', 'queue_rules:\n  - name: open\n    queue_conditions:\n      - label=go\n    merge_conditions:\n      - label=go\n');
  assert.match(releaseQueueRoute(open, { labels: ['mergify-trial'], draft: false }).reason, /more than one Mergify queue rule can take .* \(open, release\)/); // @source-text-assertion-ok subject is the returned reason
  // An exclusion counts wherever it sits among the conditions.
  const reordered = MERGIFY.replace('      - -head=changeset-release/main\n      - -files~=^tests/perf-ratchets/\n', '      - -files~=^tests/perf-ratchets/\n      - -head=changeset-release/main\n');
  assert.notEqual(reordered, MERGIFY);
  assert.equal(releaseQueueRoute(reordered, { labels: ['mergify-trial'], draft: false }).ok, true);
});

test('QUEUE: a queue action does not leak into the next rule (#9783 review)', () => {
  const text = 'pull_request_rules:\n  - name: a\n    conditions:\n      - head=x\n    actions:\n      queue:\n  - name: b\n        name: release\n';
  assert.deepEqual(parsePullRequestRules(text).map((r) => r.queue), [null, null]);
});

test('SHADOW (#9783 review): the report runs the lean lane\'s own checks and lists only lanes that ran', () => {
  const shadow = { ...BASE, mode: 'shadow', lane: 'full' };
  const allSkipped = verifyReleaseLane({ ...shadow, needs: needsJson('skipped', { changes: 'success' }) }).lines.join('\n');
  assert.match(allSkipped, /would skip:\n\n- \(none: every such lane skipped on this run\)/); // @source-text-assertion-ok subject is the returned summary
  const needs = needsJson('success', { 'rust-full': 'skipped' });
  const pass = verifyReleaseLane({ ...shadow, needs, runChecks: () => LEAN_CHECKS.map((script) => ({ script, ok: true, tail: '' })) }).lines.join('\n');
  for (const script of LEAN_CHECKS) assert.match(pass, new RegExp(`\`${script.replace(/[.]/g, '\\.')}\`: pass`));
  assert.ok(!pass.includes('`rust-full`'), 'a lane that skipped anyway is not listed');
  assert.ok(pass.includes('`viewer-tests`: success'));
  assert.match(pass, /None of them failed/); // @source-text-assertion-ok subject is the returned summary
  const fail = verifyReleaseLane({ ...shadow, needs, runChecks: () => [{ script: LEAN_CHECKS[0], ok: false, tail: 'offset mismatch' }] });
  assert.equal(fail.ok, true, 'shadow reports, never fails');
  assert.match(fail.lines.join('\n'), /FAIL: offset mismatch[\s\S]*would fail its own checks: scripts\/check-rust-major-offset\.mjs/); // @source-text-assertion-ok subject is the returned summary
  assert.doesNotMatch(fail.lines.join('\n'), /None of them failed/); // @source-text-assertion-ok subject is the returned summary
  // The real runner on scripts of its own: exit status and last output line; a missing script fails, never throws.
  const dir = mkdtempSync(join(TMP, 'checks-'));
  writeFileSync(join(dir, 'ok.mjs'), "console.log('first'); console.log('all good');\n");
  writeFileSync(join(dir, 'bad.mjs'), "console.log('offset mismatch'); process.emitWarning('noise', 'ExperimentalWarning'); process.emitWarning('old', 'DeprecationWarning'); process.exitCode = 1;\n");
  writeFileSync(join(dir, 'own.mjs'), "console.log('Warning: README missing for packages/x'); process.exitCode = 1;\n");
  assert.deepEqual(runLeanChecks(dir, ['ok.mjs', 'bad.mjs', 'own.mjs', 'gone.mjs']).map((c) => [c.script, c.ok, /Cannot find module/.test(c.tail) || c.tail]), [['ok.mjs', true, 'all good'], ['bad.mjs', false, 'offset mismatch'], ['own.mjs', false, 'Warning: README missing for packages/x'], ['gone.mjs', false, true]]);
});

test('the release queue really tests a batch: its required `Rust tests (feature builds)` runs on a PR only for a batch', () => {
  // A lean run of the release PR itself can never satisfy the queue, because
  // that lane does not run on an ordinary pull_request. That is what makes
  // the queue's batch, not this run, the gate (#8727 tested #8665).
  assert.match(jobs['rust-full'].if, /github\.event_name != 'pull_request' \|\| needs\.changes\.outputs\.batch == 'true'/); // @source-text-assertion-ok workflow wiring pin: the subject IS the YAML
  assert.ok(QUEUE_FULL_CHECKS.includes('check-success=Rust tests (feature builds)'));
});

// ---------------------------------------------------------------- the diff rule

function fakeGit(files) {
  return {
    show: (rev, path) => {
      const f = files[path];
      const v = rev === 'HEAD' ? f.after : f.before;
      if (v === undefined) throw new Error(`no ${rev}:${path}`);
      return v;
    },
  };
}
const pkg = (version, extra = {}) => JSON.stringify({ name: '@ifc-lite/x', version, dependencies: { '@ifc-lite/core': 'workspace:*', lodash: '^4.0.0' }, ...extra });

test('DIFF: a real release shape without a Rust bump passes', () => {
  const files = {
    'packages/x/package.json': { before: pkg('1.0.0'), after: pkg('1.1.0') },
    'packages/new/package.json': { before: pkg('0.0.0'), after: pkg('0.1.0') },
    'package.json': { before: pkg('12.2.0'), after: pkg('12.3.0') },
  };
  const entries = [
    { status: 'D', path: '.changeset/brave-owls-sing.md' },
    { status: 'M', path: 'packages/x/CHANGELOG.md' },
    { status: 'A', path: 'packages/new/CHANGELOG.md' },
    { status: 'M', path: 'packages/x/package.json' },
    { status: 'M', path: 'packages/new/package.json' },
    // The private root is versioned without a CHANGELOG.
    { status: 'M', path: 'package.json' },
  ];
  assert.deepEqual(diffProblems(entries, fakeGit(files)), []);
});

test('DIFF: a CHANGELOG and its package.json move together, or the diff is not a release (#9783 review)', () => {
  const files = { 'tests/fixtures/foo/package.json': { before: pkg('1.0.0'), after: pkg('1.0.1') } };
  // A version bump with no CHANGELOG is not changesets' doing: a fixture, say.
  assert.deepEqual(diffProblems([{ status: 'M', path: 'tests/fixtures/foo/package.json' }], fakeGit(files)), [
    'tests/fixtures/foo/package.json: no CHANGELOG.md beside it changed, so changesets did not bump it',
  ]);
  // A CHANGELOG edit with no bump: the root one, or a package that did not move.
  assert.deepEqual(diffProblems([{ status: 'M', path: 'packages/x/CHANGELOG.md' }], fakeGit({})), ['packages/x/CHANGELOG.md: its package.json did not change, so changesets did not write it']);
  // A package.json reformat beside a CHANGELOG edit moves no version.
  const same = { 'packages/x/package.json': { before: pkg('1.0.0'), after: JSON.stringify(JSON.parse(pkg('1.0.0')), null, 2) } };
  assert.deepEqual(diffProblems([{ status: 'M', path: 'packages/x/CHANGELOG.md' }, { status: 'M', path: 'packages/x/package.json' }], fakeGit(same)), ['packages/x/package.json: `version` did not move']);
  // `version` must stay a semver string and move forward (#9783 review).
  const bump = (before, after) => diffProblems(
    [{ status: 'M', path: 'packages/x/CHANGELOG.md' }, { status: 'M', path: 'packages/x/package.json' }],
    fakeGit({ 'packages/x/package.json': { before: JSON.stringify(before), after: JSON.stringify(after) } }),
  );
  assert.deepEqual(bump({ name: 'x', version: '1.0.0' }, { name: 'x' }), ['packages/x/package.json: `version` is not semver on both sides ("1.0.0" -> undefined)']);
  assert.deepEqual(bump({ name: 'x', version: '1.0.0' }, { name: 'x', version: 'latest' }), ['packages/x/package.json: `version` is not semver on both sides ("1.0.0" -> "latest")']);
  // Semver precedence, prerelease included: a prerelease ranks below its release (#9783 review).
  for (const [from, to] of [['1.10.0', '1.9.9'], ['1.0.0', '1.0.0-next.0'], ['1.0.0-next.1', '1.0.0-next.0'], ['1.0.0-next.10', '1.0.0-next.9'], ['1.0.0-next.0', '1.0.0-0'], ['1.0.0-next.0', '1.0.0-next'], ['1.0.0-rc.1', '1.0.0-beta.2']]) {
    assert.deepEqual(bump({ name: 'x', version: from }, { name: 'x', version: to }), [`packages/x/package.json: \`version\` did not move forward (${from} -> ${to})`], `${from} -> ${to}`);
  }
  // Past 2^53 still orders (BigInt), and equal numeric identifiers go on to the next one.
  assert.deepEqual(bump({ name: 'x', version: '1.0.0-next.9007199254740992' }, { name: 'x', version: '1.0.0-next.9007199254740993' }), []);
  assert.deepEqual(bump({ name: 'x', version: '1.0.0-1.0' }, { name: 'x', version: '1.0.0-1.1' }), []);
  // Leading zeros and empty identifiers are not semver (npm refuses them).
  for (const bad of ['1.0.00-next.0', '01.0.0', '1.0.0-01.1', '1.0.0-next..1', '1.0.0-']) {
    assert.deepEqual(bump({ name: 'x', version: '1.0.0-next.0' }, { name: 'x', version: bad }), [`packages/x/package.json: \`version\` is not semver on both sides ("1.0.0-next.0" -> "${bad}")`], bad);
  }
  for (const [from, to] of [['1.0.0', '1.0.1'], ['1.9.9', '1.10.0'], ['0.9.0', '1.0.0-next.0'], ['1.0.0-next.0', '1.0.0-next.1'], ['1.0.0-next.9', '1.0.0-next.10'], ['1.0.0-next', '1.0.0-next.0'], ['1.0.0-beta.2', '1.0.0-rc.1'], ['1.0.0-next.1', '1.0.0']]) {
    assert.deepEqual(bump({ name: 'x', version: from }, { name: 'x', version: to }), [], `${from} -> ${to}`);
  }
  // The private root has no CHANGELOG, even when sync-versions.js bumps it.
  const root = { 'package.json': { before: pkg('12.2.0'), after: pkg('12.3.0') } };
  assert.deepEqual(diffProblems([{ status: 'A', path: 'CHANGELOG.md' }, { status: 'M', path: 'package.json' }], fakeGit(root)), ['CHANGELOG.md: changesets writes no CHANGELOG for the private root']);
});

test('QUEUE: a comment between conditions does not drop the conditions after it (#9783 review)', () => {
  const text = 'queue_rules:\n  - name: release\n    queue_conditions:\n      - head=changeset-release/main\n    # entry gate\n      - label=go\n    merge_conditions:\n      - check-success=x\n';
  assert.deepEqual(parseQueueRules(text), [{ name: 'release', queue: ['head=changeset-release/main', 'label=go'], merge: ['check-success=x'], unread: false }]);
});

test('DIFF: any Cargo.toml or Cargo.lock change runs the full lanes, of any status, even a pure version bump (#9783 review)', () => {
  // Every version-only Cargo rule tried here misread some TOML spelling,
  // fail-open. The lean lane no longer judges Cargo edits.
  for (const path of ['Cargo.toml', 'Cargo.lock', 'rust/core/Cargo.toml', 'rust/core/fuzz/Cargo.lock']) {
    for (const status of ['M', 'A', 'D']) {
      const problems = diffProblems([{ status, path }], fakeGit({}));
      assert.deepEqual(problems, [`${path}: a Cargo file changed; the lean lane does not judge Cargo edits`], `${status} ${path}`);
    }
  }
});

test('DIFF: a deleted .changeset file that changesets ignores is not a consumed changeset', () => {
  // The same ignore list @changesets/read uses (scripts/lib/pending-changesets.mjs).
  for (const path of ['.changeset/README.md', '.changeset/readme.md', '.changeset/AGENTS.md', '.changeset/CLAUDE.md', '.changeset/.hidden.md']) {
    assert.deepEqual(diffProblems([{ status: 'D', path }], fakeGit({})), [`${path}: not a release file`], path);
  }
  assert.deepEqual(diffProblems([{ status: 'D', path: '.changeset/brave-cats-sing.md' }], fakeGit({})), []);
});

test('DIFF: everything that is not a version bump is named', () => {
  // Each package.json moves `version` and has a changed CHANGELOG.md beside
  // it, so it is rejected for what else it changed, not for a missing pair or
  // an unmoved version (#9783 review: test-that-cannot-fail).
  const files = {
    'a/package.json': { before: pkg('1.0.0'), after: pkg('1.1.0', { exports: { '.': './dist/index.js' } }) },
    'b/package.json': { before: pkg('1.0.0'), after: JSON.stringify({ ...JSON.parse(pkg('1.1.0')), dependencies: { '@ifc-lite/core': 'workspace:*', lodash: '^4.1.0' } }) },
    'c/package.json': { before: pkg('1.0.0'), after: JSON.stringify({ ...JSON.parse(pkg('1.1.0')), dependencies: { '@ifc-lite/core': 'file:../x', lodash: '^4.0.0' } }) },
    'd/package.json': { before: '{', after: '{}' },
  };
  const entries = [
    { status: 'A', path: '.changeset/new.md' },
    { status: 'M', path: '.changeset/config.json' },
    { status: 'M', path: 'scripts/rust-major-offset.mjs' },
    { status: 'D', path: 'packages/x/CHANGELOG.md' },
    { status: 'A', path: 'packages/y/package.json' },
    ...['a', 'b', 'c', 'd'].flatMap((p) => [{ status: 'M', path: `${p}/package.json` }, { status: 'M', path: `${p}/CHANGELOG.md` }]),
    { status: 'A', path: 'docs/CHANGELOG.md' },
  ];
  const problems = diffProblems(entries, fakeGit(files));
  const unreadable = problems.find((l) => l.startsWith('d/package.json: unreadable (')); // @source-text-assertion-ok subject is the returned problem list
  assert.ok(unreadable, problems.join('\n'));
  assert.deepEqual(problems.filter((l) => l !== unreadable), [
    '.changeset/new.md: a changeset may only be consumed (deleted)',
    '.changeset/config.json: not a release file',
    'scripts/rust-major-offset.mjs: not a release file',
    'packages/x/CHANGELOG.md: status D',
    'packages/y/package.json: status A',
    'a/package.json: `exports` changed',
    'b/package.json: `dependencies` changed',
    'c/package.json: `dependencies` changed',
    'docs/CHANGELOG.md: its package.json did not change, so changesets did not write it',
  ]);
  assert.deepEqual(diffProblems([], fakeGit({})), ['the diff is empty or unreadable']);
});

const verify = (over = {}) => verifyReleaseLane({ ...BASE, lane: 'lean', needs: needsJson('skipped', Object.fromEntries(LEAN_KEPT_JOBS.map((j) => [j, 'success']))), ...over });

test('VERIFY: a justified lean run passes and names what it skipped', () => {
  const v = verify();
  assert.equal(v.ok, true, v.lines.join('\n'));
  assert.ok(v.lines.some((l) => l.includes('`viewer-tests`'))); // @source-text-assertion-ok subject is the returned summary
});

test('VERIFY: a lean run the inputs do not justify fails', () => {
  for (const c of [{ mode: 'off' }, { mode: 'shadow' }, { headRepo: 'fork/r' }, { event: 'merge_group' }, { headRef: 'feature' }, { diff: () => ['x: not a release file'] }, { mergify: () => '' }]) {
    const v = verify(c);
    assert.equal(v.ok, false, JSON.stringify(c));
    assert.match(v.lines.join('\n'), /UNJUSTIFIED_RELEASE_LANE/); // @source-text-assertion-ok subject is the returned verdict
  }
});

test('VERIFY: a lean run whose kept jobs did not all succeed fails, since skipped passes the map', () => {
  for (const [job, r] of [['release-pr', 'skipped'], ['release-pr', 'failure'], ['release-pr', 'cancelled'], ['rust-semver', 'skipped'], ['silent-revert', 'skipped']]) {
    const v = verify({ needs: needsJson('skipped', { ...Object.fromEntries(LEAN_KEPT_JOBS.map((j) => [j, 'success'])), [job]: r }) });
    assert.equal(v.ok, false, `${job}=${r}`);
    assert.match(v.lines.join('\n'), /RELEASE_CHECKS_DID_NOT_PASS/); // @source-text-assertion-ok subject is the returned verdict
  }
});

test('VERIFY: shadow reports, and flags a failure the lean lane would defer', () => {
  const clean = verify({ mode: 'shadow', lane: 'full', needs: needsJson() });
  assert.equal(clean.ok, true);
  assert.match(clean.lines.join('\n'), /None of them failed\. The lean lane \(with CI_RELEASE_LANE=on\) would reach the same verdict/); // @source-text-assertion-ok subject is the returned summary
  const missed = verify({ mode: 'shadow', lane: 'full', needs: needsJson('success', { 'viewer-tests': 'failure', 'rust-semver': 'failure' }) });
  assert.equal(missed.ok, true, 'shadow reports; the map judges the failure');
  assert.match(missed.lines.join('\n'), /The lean lane \(with CI_RELEASE_LANE=on\) would defer a failure to the merge queue: viewer-tests\.$/); // @source-text-assertion-ok kept lanes are not listed as deferred
  // The aggregate rejects every result but success and skipped (#9783 review).
  for (const r of ['cancelled', '']) {
    const v = verify({ mode: 'shadow', lane: 'full', needs: needsJson('success', { 'viewer-tests': r }) });
    assert.match(v.lines.join('\n'), /would defer a failure to the merge queue: viewer-tests\.$/, r); // @source-text-assertion-ok subject is the returned summary
  }
  const skipped = verify({ mode: 'shadow', lane: 'full', needs: needsJson('success', { 'viewer-tests': 'skipped' }) });
  assert.match(skipped.lines.join('\n'), /None of them failed\./); // @source-text-assertion-ok subject is the returned summary
});

test('VERIFY: a full run passes; a missing decision is reported; bad NEEDS and stale job lists fail', () => {
  assert.equal(verify({ lane: 'full', needs: needsJson() }).ok, true);
  assert.match(verify({ lane: '', needs: needsJson() }).lines.join('\n'), /decision step failed or is missing/); // @source-text-assertion-ok subject is the returned summary
  assert.equal(verify({ needs: 'nope' }).ok, false);
  const stale = JSON.parse(needsJson());
  delete stale['release-pr'];
  assert.equal(verify({ needs: JSON.stringify(stale) }).ok, false);
});

// ---------------------------------------------------------------- the CLI on a real repo

function repo(change) {
  const dir = mkdtempSync(join(TMP, 'repo-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  writeFileSync(join(dir, '.mergify.yml'), MERGIFY);
  mkdirSync(join(dir, 'packages/x'), { recursive: true });
  mkdirSync(join(dir, '.changeset'));
  writeFileSync(join(dir, 'packages/x/package.json'), `${pkg('1.0.0')}\n`);
  writeFileSync(join(dir, 'packages/x/CHANGELOG.md'), '# x\n');
  writeFileSync(join(dir, '.changeset/brave-owls.md'), '---\n"@ifc-lite/x": minor\n---\n\nx\n');
  writeFileSync(join(dir, 'src.ts'), 'export {};\n');
  g('add', '-A');
  g('commit', '-qm', 'base');
  change(dir);
  g('add', '-A');
  g('commit', '-qm', 'head');
  return dir;
}

const versionBump = (dir) => {
  writeFileSync(join(dir, 'packages/x/package.json'), `${pkg('1.1.0')}\n`);
  writeFileSync(join(dir, 'packages/x/CHANGELOG.md'), '# x\n\n## 1.1.0\n');
  unlinkSync(join(dir, '.changeset/brave-owls.md'));
};

function cli(args, env, cwd) {
  const out = join(TMP, `out-${Math.random().toString(36).slice(2)}`);
  writeFileSync(out, '');
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, GITHUB_OUTPUT: out, GITHUB_EVENT_NAME: 'pull_request', CI_RELEASE_LANE: 'on', HEAD_REF: RELEASE_HEAD_REF, HEAD_REPO: 'o/r', REPO: 'o/r', BASE_REF: 'main', PR_LABELS: '["mergify-trial"]', PR_DRAFT: 'false', ...env },
  });
  const outputs = Object.fromEntries(readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => l.split('=')));
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, outputs };
}

test('CLI --decide on a real version-bump commit: lean; shadow reports; one more source file says why not lean', () => {
  const lean = cli(['--decide'], {}, repo(versionBump));
  assert.equal(lean.code, 0, lean.stderr);
  assert.deepEqual(lean.outputs, { lane: 'lean' });
  assert.deepEqual(cli(['--decide'], { CI_RELEASE_LANE: 'shadow' }, repo(versionBump)).outputs, { lane: 'full' });
  const mixed = cli(['--decide'], {}, repo((d) => { versionBump(d); writeFileSync(join(d, 'src.ts'), 'export const x = 1;\n'); }));
  assert.deepEqual(mixed.outputs, { lane: 'full' });
  assert.match(mixed.stdout, /src\.ts: not a release file/); // @source-text-assertion-ok subject is the CLI's printed reason
  const unlabelled = cli(['--decide'], { PR_LABELS: '[]' }, repo(versionBump));
  assert.match(unlabelled.stdout, /lacks `mergify-trial`/); // @source-text-assertion-ok subject is the CLI's printed reason
});

test('CLI FAIL CLOSED: no GITHUB_OUTPUT writes nothing and exits 1; --verify exits 1 on an unjustified lean', () => {
  const dir = repo(versionBump);
  assert.equal(cli(['--decide'], { GITHUB_OUTPUT: '' }, dir).code, 1);
  assert.equal(cli([], {}, dir).code, 1);
  const needs = needsJson('skipped', Object.fromEntries(LEAN_KEPT_JOBS.map((j) => [j, 'success'])));
  assert.equal(cli(['--verify'], { LANE: 'lean', NEEDS: needs }, dir).code, 0, 'justified');
  // Under shadow no lean output can be justified.
  assert.equal(cli(['--verify'], { CI_RELEASE_LANE: 'shadow', LANE: 'lean', NEEDS: needs }, dir).code, 1);
  assert.equal(cli(['--verify'], { LANE: 'full', NEEDS: needsJson() }, dir).code, 0);
});

// ---------------------------------------------------------------- the wiring

test('WIRING: `changes` decides with continue-on-error and withholds only on the exact `lean`', () => {
  const steps = jobs.changes.steps;
  const at = steps.findIndex((s) => s.id === 'release');
  const step = steps[at];
  assert.equal(step['continue-on-error'], true);
  assert.equal(step.run, 'node scripts/ci-release-lane.mjs --decide');
  for (const id of ['filter', 'tree']) {
    const s = steps.findIndex((x) => x.id === id);
    assert.ok(at < s, `the decision precedes ${id}`);
    assert.match(steps[s].if, /steps\.release\.outputs\.lane != 'lean'/, id); // @source-text-assertion-ok workflow wiring pin: the subject IS the YAML
  }
  assert.match(jobs.changes.outputs.release_lane, /steps\.release\.outputs\.lane \|\| 'full'/); // @source-text-assertion-ok workflow wiring pin: the subject IS the YAML
  // The no-op probe runs after the decision and is told to refuse a lean
  // verdict whenever the lane does not hold now (#9783 review).
  const probe = steps.findIndex((x) => x.id === 'noop');
  assert.ok(at < probe, 'the decision precedes the no-op probe');
  // The literal workflow expression this test pins, not a template string.
  // eslint-disable-next-line no-template-curly-in-string
  assert.equal(steps[probe].env.REFUSE_REPLAY_AFTER, "${{ github.head_ref == 'changeset-release/main' && steps.release.outputs.lane != 'lean' && 'Release PR checks' || '' }}");
  for (const k of ['PR_LABELS', 'PR_DRAFT']) assert.ok(step.env[k], `the decision reads ${k}`);
  for (const [key, job] of Object.entries(jobs)) {
    assert.ok(!/release_lane\s*==\s*'full'/.test(String(job.if ?? '')), `${key} must never gate on release_lane == 'full'`); // @source-text-assertion-ok workflow wiring pin: the subject IS the YAML
  }
});

test('WIRING: every job a lean run keeps is outside the path filter; every other lane is behind it', () => {
  // `changes` withholds its filter outputs, so a lane runs in a lean run only
  // if its `if` does not need one. Pin that the kept set is exactly that set.
  const filterKeys = Object.keys(jobs.changes.outputs).filter((k) => !['noop', 'replay', 'replay_run', 'replay_queue', 'lane', 'batch', 'release_lane', 'wasm_prebuilt'].includes(k)); // @source-text-assertion-ok workflow wiring pin: the subject IS the YAML
  const pathGated = (job) => filterKeys.some((k) => new RegExp(`needs\\.changes\\.outputs\\.${k} == 'true'`).test(String(job.if ?? ''))); // @source-text-assertion-ok workflow wiring pin: the subject IS the YAML
  for (const j of jobs.test.needs) {
    const job = jobs[j];
    const viaDeps = (job.needs ?? []).some?.((n) => n !== 'changes' && jobs[n] && pathGated(jobs[n]));
    const leanSkips = pathGated(job) || viaDeps || /github\.event_name != 'pull_request'/.test(String(job.if ?? '')) || j === 'release-pr'; // @source-text-assertion-ok workflow wiring pin: the subject IS the YAML
    if (LEAN_KEPT_JOBS.includes(j)) assert.ok(j === 'release-pr' || !pathGated(job), `${j} is kept but path-gated`);
    else assert.ok(leanSkips, `${j} would still run in a lean run; add it to LEAN_KEPT_JOBS or gate it`);
  }
});

test('WIRING: release-pr runs the release checks and is judged by the aggregate', () => {
  const job = jobs['release-pr'];
  // Lean runs only, so its success on a head marks a lean verdict (the probe's REFUSE_REPLAY_AFTER).
  assert.equal(job.if, "needs.changes.outputs.release_lane == 'lean' && needs.changes.outputs.noop != 'true'");
  assert.equal(job.name, 'Release PR checks');
  const runs = job.steps.map((s) => s.run).filter(Boolean);
  // No step may be skippable or ignorable: a check that cannot fail would
  // still let release-pr succeed, and its success is what a lean run needs.
  for (const step of job.steps) {
    assert.equal(step['continue-on-error'], undefined, step.name ?? step.uses);
    assert.equal(step.if, undefined, step.name ?? step.uses);
  }
  assert.equal(job['continue-on-error'], undefined);
  // Exactly LEAN_CHECKS, so shadow's --verify runs what a lean run would.
  assert.deepEqual(runs, LEAN_CHECKS.map((s) => `node ${s}`));
  // They need no history and no install (#9783 review).
  assert.equal(job.steps[0].with['fetch-depth'], undefined);
  assert.ok(!job.steps.some((st) => /pnpm/.test(String(st.uses ?? st.run ?? ''))), 'no pnpm in release-pr'); // @source-text-assertion-ok workflow wiring pin: the subject IS the YAML
  assert.ok(jobs.test.needs.includes('release-pr')); // @source-text-assertion-ok workflow wiring pin: the subject IS the YAML
  const verifyStep = jobs.test.steps.find((s) => s.run === 'node scripts/ci-release-lane.mjs --verify');
  const gateAt = jobs.test.steps.findIndex((s) => s.name === 'Gate on dependencies');
  assert.ok(jobs.test.steps.indexOf(verifyStep) < gateAt); // @source-text-assertion-ok workflow wiring pin: the subject IS the YAML
  assert.match(verifyStep.if, /needs\.changes\.outputs\.release_lane == 'lean'/); // @source-text-assertion-ok workflow wiring pin: the subject IS the YAML
  const checkout = jobs.test.steps[jobs.test.steps.indexOf(verifyStep) - 1];
  assert.equal(checkout.with['fetch-depth'], 2, 'verify re-reads HEAD~1');
  assert.equal(checkout.if, verifyStep.if);
});
