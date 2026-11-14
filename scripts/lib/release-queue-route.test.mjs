/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The release PR's Mergify route check: the narrow .mergify.yml reader,
 * pinned against a real YAML parse, and every refusal.
 *
 * Run: node --test scripts/lib/release-queue-route.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

import { QUEUE_FULL_CHECKS, parsePullRequestRules, parseQueueRules, releaseQueueRoute } from './release-queue-route.mjs';

const MERGIFY = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../.mergify.yml'), 'utf8');

test('REFUSE: a queue Mergify could check in place, or an entry condition this script cannot judge', () => {
  // Mergify judges the PR's own run (in place, or merges without a draft)
  // only for single-step CI: merge_conditions empty or equal to the queue's.
  const rule = parseQueueRules(MERGIFY).find((r) => r.name === 'release');
  const singleStep = `queue_rules:\n  - name: release\n    queue_conditions:\n${[...rule.queue, ...QUEUE_FULL_CHECKS].map((c) => `      - ${c}`).join('\n')}\n    merge_conditions:\n${[...rule.queue, ...QUEUE_FULL_CHECKS].map((c) => `      - ${c}`).join('\n')}\n`;
  assert.match(releaseQueueRoute(singleStep, { labels: ['mergify-trial'], draft: false }).reason, /single-step/);
  const unknown = MERGIFY.replace('      - head=changeset-release/main\n    merge_conditions', '      - head=changeset-release/main\n      - base=main\n    merge_conditions');
  assert.notEqual(unknown, MERGIFY, 'the fixture edit applied');
  assert.match(releaseQueueRoute(unknown, { labels: ['mergify-trial'], draft: false }).reason, /cannot judge: base=main/);
});

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
    assert.match(r.reason, why);
  }
  // An entry condition it cannot judge refuses; one it can, and the PR lacks, is PR state.
  const odd = MERGIFY.replace(rule, 'head=changeset-release/main\n      - author=someone\n    actions:\n      queue:\n        name: release');
  assert.match(releaseQueueRoute(odd, { labels: ['mergify-trial'], draft: false }).reason, /cannot judge: author=someone/);
  const labelled = MERGIFY.replace(rule, 'head=changeset-release/main\n      - label=release-ok\n    actions:\n      queue:\n        name: release');
  const r = releaseQueueRoute(labelled, { labels: ['mergify-trial'], draft: false });
  assert.equal(r.ok, true);
  assert.equal(r.queueable, false);
  assert.match(r.queueReason, /lacks `release-ok`/);
  // Two entry rules: either one's gaps would do, so both are named as alternatives.
  const second = labelled.replace('pull_request_rules:\n', 'pull_request_rules:\n  - name: alt\n    conditions:\n      - head=changeset-release/main\n      - label=alt-ok\n    actions:\n      queue:\n        name: release\n\n');
  // A gap the queue rule already names is not repeated per entry rule.
  const both = releaseQueueRoute(second, { labels: [], draft: false }).queueReason;
  assert.match(both, /will not take this PR yet: it lacks `mergify-trial`, it lacks `alt-ok`, or it lacks `release-ok`$/);
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
    ['  - name: flow\n    conditions:\n      - label=go\n    actions: {merge: {}}', /`flow` has lines this script cannot read/],
    ['  - name: deep\n    conditions:\n      - label=go\n    actions:\n        queue:\n          name: default', /`deep` has no actions this script can read/],
    // a merge key next to a safe action, an alias, a rule not led by `name`, a mapping where a list belongs
    ['  - name: sneaky\n    conditions:\n      - label=go\n    actions:\n      comment:\n        message: hi\n      <<: *direct_merge', /`sneaky` has lines this script cannot read/],
    ['  - name: alias\n    conditions: *conds\n    actions:\n      comment:\n        message: hi', /`alias` has lines this script cannot read/],
    ['  - conditions:\n      - label=go\n    name: late\n    actions:\n      merge: {}', /`\(unnamed: - conditions:\)` has lines this script cannot read/],
    ['  - name: mapped\n    conditions:\n      or: [label=go]\n    actions:\n      comment:\n        message: hi', /`mapped` has lines this script cannot read/],
    // a flow-style list, and a head spelled other than a plain branch name
    ['  - name: flowlist\n    conditions: [label=go]\n    actions:\n      comment:\n        message: hi', /`flowlist` has lines this script cannot read/],
    ['  - name: tagged\n    conditions: !!seq [label=go]\n    actions:\n      comment:\n        message: hi', /`tagged` has lines this script cannot read/],
    ['  - name: spaced\n    conditions:\n      - head= changeset-release/main\n    actions:\n      merge: {}', /`spaced` has a condition this script cannot judge: head= changeset-release\/main/],
    // approving or un-drafting can unblock a merge, so they are not safe
    ['  - name: say\n    conditions:\n      - label=go\n    actions:\n      comment:\n        message: \"@Mergifyio queue\"', /`say` can comment the release PR/],
    ['  - name: approve\n    conditions:\n      - head=changeset-release/main\n    actions:\n      review:\n        type: APPROVE', /`approve` can review the release PR/],
    ['  - name: other\n    conditions:\n      - head=changeset-release/main\n    actions:\n      queue:\n        name: default', /`other` can queue the release PR into `default`/],
    ['  - name: inline\n    conditions:\n      - head=changeset-release/main\n    actions:\n      queue: {name: release}', /`inline` can queue the release PR into a queue this script cannot read/],
  ];
  for (const [r, why] of cases) {
    const route = releaseQueueRoute(extra(r), { labels: ['mergify-trial'], draft: false });
    assert.equal(route.ok, false, r);
    assert.match(route.reason, why);
  }
  // A rule excluding the release head, or with no routing action, is no route.
  for (const r of ['  - name: ex\n    conditions:\n      - -head=changeset-release/main\n    actions:\n      queue:\n        name: default', '  - name: elsewhere\n    conditions:\n      - head=feature/x\n    actions:\n      merge: {}', '  - name: not-x\n    conditions:\n      - -head=feature/x\n      - label=go\n    actions:\n      queue:\n        name: release', '  - name: note\n    conditions:\n      - label=go\n    actions:\n      label:\n        add:\n          - seen']) {
    assert.equal(releaseQueueRoute(extra(r), { labels: ['mergify-trial'], draft: false }).ok, true, r);
  }
  // A top-level key it does not read can add a route (`extends` merges another config).
  assert.match(releaseQueueRoute(`extends: org/.github\n${MERGIFY}`, { labels: ['mergify-trial'], draft: false }).reason, /top-level line\(s\) this script does not read: extends: org\/\.github/);
  for (const top of ['---', 'queue_rules: []', '? extends']) {
    assert.match(releaseQueueRoute(`${MERGIFY}\n${top}\n`, { labels: ['mergify-trial'], draft: false }).reason, /top-level line\(s\) this script does not read/, top);
  }
  // A comment on a known key, and a quoted template setting, are understood.
  assert.equal(releaseQueueRoute(MERGIFY.replace('queue_rules:\n', 'queue_rules:  # see header\n').replace('    batch_size: 1\n    merge_method: squash\n', '    batch_size: 1\n    commit_message_template: "{{ title }} (#{{ number }})"\n    merge_method: squash\n'), { labels: ['mergify-trial'], draft: false }).ok, true);
  // A list indented past its key is unread, not empty.
  assert.match(releaseQueueRoute(MERGIFY.replace(/^pull_request_rules:\n([\s\S]*)$/m, (_, body) => `pull_request_rules:\n${body.replace(/^/gm, '  ')}`), { labels: ['mergify-trial'], draft: false }).reason, /has lines this script cannot read/);
  // Two queue rules taking the release head: the other could be single-step.
  const twoQueues = MERGIFY.replace('queue_rules:\n', 'queue_rules:\n  - name: release-fast\n    queue_conditions:\n      - head=changeset-release/main\n    merge_conditions:\n      - head=changeset-release/main\n');
  assert.match(releaseQueueRoute(twoQueues, { labels: ['mergify-trial'], draft: false }).reason, /more than one Mergify queue rule can take head=changeset-release\/main \(release-fast, release\)/);
  // A queue with no head condition can take it too (autoqueue, `@Mergifyio queue open`).
  const open = MERGIFY.replace('queue_rules:\n', 'queue_rules:\n  - name: open\n    queue_conditions:\n      - label=go\n    merge_conditions:\n      - label=go\n');
  assert.match(releaseQueueRoute(open, { labels: ['mergify-trial'], draft: false }).reason, /more than one Mergify queue rule can take .* \(open, release\)/);
  // An exclusion counts wherever it sits among the conditions.
  const reordered = MERGIFY.replace('      - -head=changeset-release/main\n      - -files~=^tests/perf-ratchets/\n', '      - -files~=^tests/perf-ratchets/\n      - -head=changeset-release/main\n');
  assert.notEqual(reordered, MERGIFY);
  assert.equal(releaseQueueRoute(reordered, { labels: ['mergify-trial'], draft: false }).ok, true);
});

test('QUEUE: a queue action does not leak into the next rule (#9783 review)', () => {
  const text = 'pull_request_rules:\n  - name: a\n    conditions:\n      - head=x\n    actions:\n      queue:\n  - name: b\n        name: release\n';
  assert.deepEqual(parsePullRequestRules(text).map((r) => r.queue), [null, null]);
});

test('QUEUE: a comment between conditions does not drop the conditions after it (#9783 review)', () => {
  const text = 'queue_rules:\n  - name: release\n    queue_conditions:\n      - head=changeset-release/main\n    # entry gate\n      - label=go\n    merge_conditions:\n      - check-success=x\n';
  assert.deepEqual(parseQueueRules(text), [{ name: 'release', queue: ['head=changeset-release/main', 'label=go'], merge: ['check-success=x'], unread: false }]);
});
