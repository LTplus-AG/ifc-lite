#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The lean lane for the Version Packages PR (`changeset-release/main`).
 *
 * WHY. changesets/action rewrites that PR after every merge to `main`, so it
 * had 183 `Test` runs on 170 heads in the week of 2026-11-04, about 100
 * runner-hours, almost all of it the full suite testing version bumps. Its
 * diff is package.json versions, CHANGELOGs and deleted changesets, plus
 * Cargo versions when Rust crates are bumped. Any Cargo change runs in full
 * (release-version-diff.mjs). Three of the four release MERGES before
 * 2026-11-12 (#8665, #8359, #8311, #8192) touched Cargo.lock; what share of
 * the PR's many intermediate heads would still go lean is not measured, and
 * shadow mode is how to measure it.
 *
 * WHY THE OWNER'S SWITCH. A lean run is sound only if the PR cannot reach `main`
 * except through Mergify's `release` queue, whose merge conditions require the
 * full lanes and whose two-step CI makes Mergify test on a
 * `mergify/merge-queue/*` draft (observed: draft #8727 for #8665), where
 * ci-pr-lane.mjs runs every lane. `releaseQueueRoute` checks the config and
 * that this PR meets the queue's entry conditions. But a lean run turns the
 * required aggregate green, and whether a PR with green required checks can
 * be merged directly is set outside this repository (the `main` ruleset). So
 * the lean lane sits behind OWNER_ALLOWS_LEAN, which the owner released on
 * 2026-11-12 relying on that ruleset; false makes `on` report like `shadow`.
 *
 * THE SWITCH is the repo variable `CI_RELEASE_LANE`:
 *   unset / `off`  today's behaviour.
 *   `shadow`       every lane runs; the aggregate's summary lists what the
 *                  lean lane would skip and whether any of it failed, runs
 *                  the lean lane's own checks (LEAN_CHECKS), and names what
 *                  still stands between this run and a lean one.
 *   `on`           the release PR runs `changes` (late-changeset gate),
 *                  `rust-semver`, `silent-revert` and `release-pr` (Rust
 *                  major-offset and README checks) and skips the rest. With
 *                  OWNER_ALLOWS_LEAN false, as `shadow`.
 * Any other value is `off`. Lean needs ALL of: a `pull_request` into `main`,
 * head ref exactly `changeset-release/main`, the head in this repository (a
 * fork's branch of that name runs full), the Mergify route above, a diff that
 * only moves versions (`diffProblems`), and OWNER_ALLOWS_LEAN.
 *
 * FAIL CLOSED, BY POLARITY. `changes` withholds its path-filter outputs only
 * when this step printed exactly `lane=lean`; a crash, an empty or a garbled
 * output runs the path filter and every lane. The aggregate re-derives the
 * decision (`--verify`) and fails a lean run it cannot justify, because it
 * counts `skipped` as a pass. A body-only edit does not replay a lean verdict
 * unless the lane still holds: `release-pr` runs only in a lean run, and the
 * no-op probe refuses to replay a head where it succeeded (test.yml).
 *
 *   node scripts/ci-release-lane.mjs --decide   `changes` job; writes the lane output
 *   node scripts/ci-release-lane.mjs --verify   aggregate; exit 1 on an unjustified lean run
 *
 * Inputs: GITHUB_EVENT_NAME, CI_RELEASE_LANE, HEAD_REF, HEAD_REPO, REPO,
 * BASE_REF, PR_LABELS (JSON array of names), PR_DRAFT; for --verify also LANE (the `changes` output) and NEEDS
 * (`toJSON(needs)`). Both read the PR's diff as `git diff HEAD~1 HEAD` on the
 * merge-ref checkout, so they need fetch-depth 2.
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import { boundedSpawnSync } from './lib/bounded-process.mjs';
import { isMainEntry } from './lib/is-main-entry.mjs';
import { diffProblems } from './lib/release-version-diff.mjs';

export const RELEASE_HEAD_REF = 'changeset-release/main';
export const MODES = ['off', 'shadow', 'on'];

/** Jobs a lean run still runs. Every other job the aggregate needs is skipped. */
export const LEAN_KEPT_JOBS = ['changes', 'rust-semver', 'silent-revert', 'release-pr'];

/**
 * What `release-pr` runs, one step each (test.yml pins the job to this list).
 * Node builtins only and no history, so `--verify` can run them on its own
 * depth-2 checkout in shadow, where `release-pr` itself does not run.
 * check-changesets.mjs and check-changeset-bump.mjs are not here: on a release
 * PR no changeset is pending and the bump check anchors on the release head
 * itself, so both pass vacuously (run on a6b915f888 merged into its base,
 * #9783 review).
 */
export const LEAN_CHECKS = ['scripts/check-rust-major-offset.mjs', 'scripts/docs/check-package-readmes.mjs'];

/** The release queue must require these, or the queue is not the full gate. */
export const QUEUE_FULL_CHECKS = [
  'check-success=Build + WASM + Rust + Node',
  'check-success=Viewer tests (shard 0)',
  'check-success=Rust tests (feature builds)',
];

/** `<key>:` alone on a top-level line, a trailing comment allowed. */
const isTopKey = (line, key) => line.startsWith(`${key}:`) && /^\s*(#.*)?$/.test(line.slice(key.length + 1));

/**
 * One rule list (`queue_rules` or `pull_request_rules`) from .mergify.yml,
 * read by indentation. Deliberately narrow: a line it does not understand
 * marks its rule `unread`, which releaseQueueRoute refuses (runs full).
 * The tests pin both callers against a real YAML parse of the file. Each rule
 * keeps its 4-space list sections, the names of its actions, and the queue
 * its `actions.queue` names in block form (null otherwise).
 *
 * @returns {{ name: string, lists: Record<string, string[]>, actions: string[], queue: string|null, unread: boolean }[]}
 */
function readRules(text, topKey) {
  const rules = [];
  let inList = false;
  let rule = null;
  // A 4-space section key, or `actions.queue` inside `actions`.
  let section = null;
  // A line this reader does not understand marks its rule `unread`, which the
  // caller refuses: a dropped line must never read as an absent one. With no
  // rule yet (content before the first `  - ` item), it starts an unnamed one.
  const unread = (line) => {
    if (!rule) rules.push((rule = { name: `(unnamed: ${line.trim()})`, lists: {}, actions: [], queue: null, unread: true }));
    rule.unread = true;
  };
  for (const line of String(text ?? '').split('\n')) {
    // A comment ends nothing: one between two conditions must not drop the rest.
    if (/^\s*(#|$)/.test(line)) continue;
    if (/^\S/.test(line)) {
      inList = isTopKey(line, topKey);
      rule = null;
      section = null;
      continue;
    }
    if (!inList) continue;
    let m = /^ {2}- name:\s*(\S.*?)\s*$/.exec(line);
    if (m) {
      rule = { name: m[1], lists: {}, actions: [], queue: null, unread: false };
      rules.push(rule);
      section = null;
      continue;
    }
    if (/^ {2}\S/.test(line) || !rule) {
      // A rule whose first key is not `name`, or content before the first item.
      if (/^ {2}\S/.test(line)) rule = null;
      unread(line);
      section = null;
      continue;
    }
    // YAML anchors, aliases and merge keys can carry content from elsewhere.
    if (/(^|\s)(<<:|[&*][\w-]+)/.test(line)) {
      unread(line);
      continue;
    }
    m = /^ {4}(\w+):\s*$/.exec(line);
    if (m) {
      section = m[1];
      continue;
    }
    if (/^ {4}\w+:\s*\S/.test(line)) {
      // Only a plain or quoted scalar (`batch_size: 1`, `x: "{{ title }}"`) is
      // understood; a flow list or map, a tag or a block scalar is content.
      if (!/^ {4}\w+:\s+("[^"]*"|'[^']*'|\w[^[\]{}]*)\s*(#.*)?$/.test(line)) unread(line);
      section = null;
      continue;
    }
    if (/^ {4}\S/.test(line) || !section) {
      unread(line);
      continue;
    }
    if (section.startsWith('actions')) {
      if ((m = /^ {6}(\w+):/.exec(line))) {
        rule.actions.push(m[1]);
        section = /^ {6}queue:\s*$/.test(line) ? 'actions.queue' : 'actions';
      } else if (section === 'actions.queue' && (m = /^ {8}name:\s*(\S.*?)\s*$/.exec(line))) {
        rule.queue = m[1];
      } else if (!/^ {8,}\S/.test(line)) {
        unread(line);
      }
      continue;
    }
    if ((m = /^ {6}- (\S.*?)\s*$/.exec(line))) (rule.lists[section] ??= []).push(m[1]);
    else unread(line);
  }
  return rules;
}

/**
 * @param {string} text  .mergify.yml
 * @returns {{ name: string, queue: string[], merge: string[], unread: boolean }[]}
 */
export function parseQueueRules(text) {
  return readRules(text, 'queue_rules').map((r) => ({ name: r.name, queue: r.lists.queue_conditions ?? [], merge: r.lists.merge_conditions ?? [], unread: r.unread }));
}

/**
 * Each pull_request_rule's conditions, action names, and the queue its
 * `queue` action names (null if none, or not in block form).
 *
 * @param {string} text  .mergify.yml
 * @returns {{ name: string, conditions: string[], actions: string[], queue: string|null, unread: boolean }[]}
 */
export function parsePullRequestRules(text) {
  return readRules(text, 'pull_request_rules').map((r) => ({ name: r.name, conditions: r.lists.conditions ?? [], actions: r.actions, queue: r.queue, unread: r.unread }));
}

/**
 * pull_request_rules actions that cannot put a PR on a path to `main`. Any
 * other action, known or not, must be a `queue` into the release queue. Not
 * `comment` (a posted `@Mergifyio queue` is a route), nor `review`/`edit`
 * (an approval or un-drafting can unblock a merge).
 */
const SAFE_ACTIONS = ['label', 'assign', 'request_reviews', 'dismiss_reviews', 'close', 'delete_head_branch', 'post_check'];

/**
 * Top-level .mergify.yml keys this script accounts for: the two rule lists
 * it reads in full, and two that cannot add a route. Any other (`extends`,
 * `defaults`, `shared`, ...) can, and is not read: it refuses.
 */
const KNOWN_TOP_KEYS = ['queue_rules', 'pull_request_rules', 'priority_rules', 'merge_protections_settings'];

/** Top-level lines that are not exactly `<known key>:` (as readRules sees top level). */
function unknownTopLines(text) {
  return String(text ?? '').split('\n').filter((l) => /^\S/.test(l) && !/^#/.test(l) && !KNOWN_TOP_KEYS.some((k) => isTopKey(l, k)));
}

const RELEASE_HEAD = `head=${RELEASE_HEAD_REF}`;
const PLAIN_HEAD = /^(-?)head=([\w./-]+)$/;

/**
 * Mergify conditions judged for the release PR: `{ never }` when one can
 * never hold for it (bound to another head, or excluding this one),
 * `{ unknown }` for the first one this script cannot judge, else what is
 * unmet now. `status-success=`/`check-success=` are skipped (see below).
 */
function judgeConditions(conditions, { labels, draft }) {
  // Head conditions first, so an exclusion wins whatever the order:
  // `-head=` another branch holds; `head=` another, or `-head=` this one,
  // never does. Only a plain branch name is judged; any other spelling
  // (spaces, quotes) is unknown below.
  for (const c of conditions) {
    const head = PLAIN_HEAD.exec(c);
    if (head && (head[1] === '-') === (head[2] === RELEASE_HEAD_REF)) return { never: c };
  }
  const unmet = [];
  for (const c of conditions) {
    if (PLAIN_HEAD.test(c) || /^(status|check)-success=/.test(c)) continue;
    if (c === '-draft') {
      if (draft !== false) unmet.push('it is a draft (or its draft state is unknown)');
      continue;
    }
    const label = /^label=(.+)$/.exec(c);
    if (label) {
      if (!labels.includes(label[1])) unmet.push(`it lacks \`${label[1]}\``);
      continue;
    }
    return { unknown: c };
  }
  return { unmet };
}

/**
 * Does .mergify.yml route THIS release PR through a queue that runs the full
 * gate? The file may hold only the top-level keys in KNOWN_TOP_KEYS, and
 * every rule of both lists must be read in full (a line the reader does not
 * understand refuses). Then four parts, checked in this order:
 *  - exactly one queue rule's conditions do not exclude the release head
 *    (any queue could take it: a rule, `@Mergifyio queue`, autoqueue), and
 *    every other entry condition of that rule is
 *    one it can read; any other refuses (`ok: false`). Whether THIS PR meets
 *    them now (`label=`, `-draft`) is returned apart, as `queueable`, since a
 *    label can change: shadow reports either way, only a lean run needs it.
 *    `status-success=`/`check-success=` conditions are NOT judged:
 *    their result is not known when this runs, and one that never passes
 *    keeps the PR out of the queue, leaving its own run as the last gate
 *    before a direct merge. The owner accepted that risk (OWNER_ALLOWS_LEAN).
 *  - its merge conditions require the full-lane checks.
 *  - its CI is two-step (merge conditions present and not the queue
 *    conditions). Mergify checks a PR in place, or merges it without a draft,
 *    only when the CI is single-step (docs.mergify.com/merge-queue/rules,
 *    `allow_inplace_checks`), so two-step means the full lanes run on a
 *    `mergify/merge-queue/*` draft, where ci-pr-lane.mjs runs every lane.
 *  - every pull_request_rule its conditions do not exclude, and with an
 *    action outside SAFE_ACTIONS, only queues into that queue; at least one
 *    does (without one Mergify never queues it). Their conditions are
 *    judged like the queue's own.
 *
 * @param {string} text  .mergify.yml
 * @param {{ labels?: string[], draft?: boolean }} pr
 * @returns {{ ok: false, reason: string } | { ok: true, reason: string, queueable: boolean, queueReason: string }}
 *   Read `queueable` only after `ok`: it is absent on a refusal.
 */
export function releaseQueueRoute(text, { labels = [], draft = true } = {}) {
  const pr = { labels, draft };
  const unknownTop = unknownTopLines(text);
  if (unknownTop.length > 0) return { ok: false, reason: `.mergify.yml has top-level line(s) this script does not read: ${unknownTop.join(', ')}` };
  const queueRules = parseQueueRules(text);
  const prRules = parsePullRequestRules(text);
  const unreadRule = [...queueRules, ...prRules].find((r) => r.unread);
  if (unreadRule) return { ok: false, reason: `Mergify rule \`${unreadRule.name}\` has lines this script cannot read` };
  // Every queue the release PR could enter (a rule, `@Mergifyio queue`, or
  // autoqueue) counts, unless its conditions exclude the release head.
  const takers = queueRules.map((r) => ({ r, judged: judgeConditions(r.queue, pr) })).filter((t) => !t.judged.never);
  if (takers.length === 0) return { ok: false, reason: `no Mergify queue rule takes ${RELEASE_HEAD}` };
  if (takers.length > 1) return { ok: false, reason: `more than one Mergify queue rule can take ${RELEASE_HEAD} (${takers.map((t) => t.r.name).join(', ')})` };
  // `ok` is about the CONFIG; `unmet` is about this PR right now (a label or
  // draft state can change), reported separately so shadow can still measure.
  const [{ r: rule, judged: queueJudged }] = takers;
  if (queueJudged.unknown) return { ok: false, reason: `Mergify queue \`${rule.name}\` has an entry condition this script cannot judge: ${queueJudged.unknown}` };
  const missing = QUEUE_FULL_CHECKS.filter((c) => !rule.merge.includes(c));
  if (missing.length > 0) return { ok: false, reason: `Mergify queue \`${rule.name}\` does not require ${missing.join(', ')}` };
  const sameAsQueue = rule.merge.length === rule.queue.length && rule.merge.every((c) => rule.queue.includes(c));
  if (sameAsQueue) return { ok: false, reason: `Mergify queue \`${rule.name}\` is single-step CI, so Mergify may judge the PR's own run in place` };
  // Every rule with an action outside SAFE_ACTIONS that the release PR can
  // match must be an entry into this queue: any other route could merge it
  // without the full lanes.
  const entryJudged = [];
  for (const r of prRules) {
    const judged = judgeConditions(r.conditions, pr);
    if (judged.never) continue;
    // No readable action is an unreadable rule, never a harmless one.
    if (r.actions.length === 0) return { ok: false, reason: `Mergify rule \`${r.name}\` has no actions this script can read` };
    const unsafe = r.actions.filter((a) => !SAFE_ACTIONS.includes(a));
    if (unsafe.length === 0) continue;
    if (judged.unknown) return { ok: false, reason: `Mergify rule \`${r.name}\` has a condition this script cannot judge: ${judged.unknown}` };
    const other = unsafe.filter((a) => a !== 'queue');
    if (other.length > 0) return { ok: false, reason: `Mergify rule \`${r.name}\` can ${other.join('/')} the release PR` };
    if (r.queue !== rule.name) return { ok: false, reason: `Mergify rule \`${r.name}\` can queue the release PR into ${r.queue ? `\`${r.queue}\`` : 'a queue this script cannot read'}, not \`${rule.name}\`` };
    entryJudged.push(judged);
  }
  if (entryJudged.length === 0) return { ok: false, reason: `no Mergify pull_request_rules entry queues ${RELEASE_HEAD} into \`${rule.name}\`` };
  // Any one matching entry rule queues the PR; when none is met, each rule's
  // gaps beyond the queue's own are alternatives.
  const extra = entryJudged.map((e) => e.unmet.filter((u) => !queueJudged.unmet.includes(u)));
  const entryGap = extra.some((u) => u.length === 0) ? null : extra.map((u) => u.join(' and ')).join(', or ');
  const unmet = [...queueJudged.unmet, ...(entryGap ? [entryGap] : [])];
  const queueable = unmet.length === 0;
  const queueReason = queueable ? `Mergify queue \`${rule.name}\` takes this PR` : `Mergify queue \`${rule.name}\` will not take this PR yet: ${unmet.join(', ')}`;
  return { ok: true, reason: `Mergify queue \`${rule.name}\` gates the merge on the full lanes of a draft`, queueable, queueReason };
}

/**
 * THE OWNER'S HOLD. A lean run makes the required aggregate green on the
 * release PR, and nothing in this repository can stop a direct merge of a PR
 * whose required checks are green: the queue route above is checked when the
 * run starts, a label can be removed after it, and making a lean run leave
 * the aggregate red would also keep the PR out of the queue, because Mergify
 * injects branch-protection checks as queue conditions by default
 * (`branch_protection_injection_mode: queue`). Whether a direct merge is
 * possible is set outside the repository: today the `main` ruleset lets only
 * Mergify update `main`. The owner chose to rely on that (2026-11-12, #9783),
 * so the hold is released; setting it back to false makes `on` behave as
 * `shadow` again. The steps of the jobs a lean run skips are not audited for
 * version-reading checks beyond those in LEAN_CHECKS; shadow measures that.
 */
export const OWNER_ALLOWS_LEAN = true;

/**
 * Pure decision.
 *
 * @param {{ event?: string, mode?: string, headRef?: string, headRepo?: string, repo?: string, baseRef?: string,
 *   labels?: string, draft?: string, mergify?: () => string, diff?: () => string[], ownerAllowsLean?: boolean }} input
 *   `labels` is the JSON array of PR label names and `draft` the string `true`/`false`, as test.yml passes them.
 *   `mergify` and `diff` are read only when needed.
 * @returns {{ lane: 'lean'|'full', mode: string, pending?: string[], reason: string, warning?: string }}
 *   `pending` is set exactly on a reported-only (shadow or held) decision and names every
 *   condition still between this run and a lean one (never empty there:
 *   lean is exactly the empty list).
 */
export function decideReleaseLane({ event, mode, headRef, headRepo, repo, baseRef, labels, draft, mergify, diff, ownerAllowsLean = OWNER_ALLOWS_LEAN }) {
  const raw = String(mode ?? '').toLowerCase();
  const m = raw === '' ? 'off' : raw;
  const full = (reason, extra = {}) => ({ lane: 'full', mode: m, reason, ...extra });
  if (!MODES.includes(m)) return full('unknown CI_RELEASE_LANE value', { mode: 'off', warning: `CI_RELEASE_LANE=${JSON.stringify(String(mode))} is not one of ${MODES.join(', ')}; running the full lanes` });
  if (m === 'off') return full('CI_RELEASE_LANE is unset or off');
  if (headRef !== RELEASE_HEAD_REF) return full('not the release PR');
  if (event !== 'pull_request') return full(`${event || 'unknown event'} always runs the full lanes`);
  if (baseRef !== 'main') return full(`base is ${JSON.stringify(baseRef)}, not main`);
  if (!repo || headRepo !== repo) return full(`head is in ${JSON.stringify(headRepo)}, not this repository`);
  let route;
  try {
    const names = JSON.parse(labels ?? 'null');
    if (!Array.isArray(names) || names.some((n) => typeof n !== 'string')) throw new Error('PR_LABELS is not a JSON array of strings');
    route = releaseQueueRoute(mergify(), { labels: names, draft: draft === 'true' ? true : draft === 'false' ? false : undefined });
  } catch (err) {
    route = { ok: false, reason: `the queue route is unreadable (${err.message})` };
  }
  if (!route.ok) return full(`${route.reason}, so this run is the only gate`, { warning: `release lane refused: ${route.reason}` });
  let problems;
  try {
    problems = diff();
  } catch (err) {
    problems = [`diff unreadable (${err.message})`];
  }
  if (problems.length > 0) return full(`the diff is more than a version bump: ${problems.slice(0, 5).join('; ')}`);
  // The ONE list of what still stands between this run and a lean one. Lean
  // happens only when it is empty, so a condition added here cannot be left
  // out, and the report cannot list one the decision ignores. Shadow and the
  // held `on` report it whatever the PR's queue state: measuring must not
  // wait on a label.
  const pending = [
    m === 'shadow' ? 'with CI_RELEASE_LANE=on' : '',
    ownerAllowsLean ? '' : 'with OWNER_ALLOWS_LEAN released',
    route.queueable ? '' : 'once this PR is queueable',
  ].filter(Boolean);
  if (pending.length === 0) return { mode: m, lane: 'lean', reason: `CI_RELEASE_LANE=on on the release PR; ${route.queueReason}; ${route.reason}` };
  if (m === 'shadow') return full(`shadow mode: full lanes run, lean lane reported; ${route.queueReason}`, { pending });
  if (!ownerAllowsLean) return full(`CI_RELEASE_LANE=on, but the lean lane is held until the owner decides how release PRs reach main (OWNER_ALLOWS_LEAN); full lanes run, lean lane reported; ${route.queueReason}`, { pending, warning: 'CI_RELEASE_LANE=on is held (OWNER_ALLOWS_LEAN=false); running the full lanes' });
  // `on`, hold released, something still pending: refused outright, naming
  // what is pending, because this run would be the last gate.
  return full(`lean lane not granted, still pending: ${pending.join(', ')}; queue state: ${route.queueReason}`, { warning: `release lane refused; still pending: ${pending.join(', ')}` });
}

/**
 * The aggregate's check. A `lean` lane must re-derive as lean, the kept jobs
 * must exist and have succeeded: a skipped one would pass the aggregate's map.
 */
export function verifyReleaseLane(input) {
  const d = decideReleaseLane(input);
  const runChecks = input.runChecks ?? (() => []);
  let results;
  try {
    results = JSON.parse(input.needs ?? '');
  } catch {
    return { ok: false, lines: ['❌ NEEDS is not readable JSON; cannot tell which lanes ran.'] };
  }
  const unknown = LEAN_KEPT_JOBS.filter((j) => !(j in results));
  if (unknown.length > 0) return { ok: false, lines: [`❌ ci-release-lane.mjs names job(s) the aggregate does not need: ${unknown.join(', ')}. Update LEAN_KEPT_JOBS.`] };
  const resultOf = (j) => results[j]?.result ?? 'absent';
  const skippedByLean = Object.keys(results).filter((j) => !LEAN_KEPT_JOBS.includes(j));
  const row = (j) => `- \`${j}\`: ${resultOf(j)}`;
  if (input.lane === 'lean') {
    if (d.lane !== 'lean') return { ok: false, lines: [`❌ UNJUSTIFIED_RELEASE_LANE: \`changes\` chose the lean lane but this run re-derives \`${d.lane}\` (${d.reason}). Skipped lanes are not a pass here.`] };
    // `skipped` passes the aggregate's map, so a kept job that did not run
    // would leave the lean run with no gate at all.
    const notRun = LEAN_KEPT_JOBS.filter((j) => resultOf(j) !== 'success');
    if (notRun.length > 0) return { ok: false, lines: [`❌ RELEASE_CHECKS_DID_NOT_PASS: a lean run needs every kept job to succeed: ${notRun.map((j) => `\`${j}\` was ${resultOf(j)}`).join(', ')}.`] };
    return { ok: true, lines: ['## Release PR lean lane (`CI_RELEASE_LANE=on`)', '', d.reason, '', 'Skipped on purpose; the `release` merge queue runs them:', '', ...skippedByLean.map(row)] };
  }
  if (d.pending) {
    // The aggregate's own rule (`case "$r" in success|skipped) ;;`): anything
    // else, `cancelled` included, is a rejection the lean lane would defer.
    const failed = skippedByLean.filter((j) => !['success', 'skipped'].includes(resultOf(j)));
    // A lane that skipped here skips on this PR whatever the lean lane does.
    const ran = skippedByLean.filter((j) => resultOf(j) !== 'skipped').map(row);
    // `release-pr` runs only in a lean run, so its checks run here instead.
    const checks = runChecks();
    const checksFailed = checks.filter((c) => !c.ok).map((c) => c.script);
    // The decision names what still stands between this run and a lean one,
    // so the report never reads as a claim about today.
    const lean = `lean lane (${d.pending.join(', ')})`;
    const lines = [`## Release PR lean lane, reported only (\`CI_RELEASE_LANE=${d.mode}\`)`, '', d.reason, '', `Lanes that ran here and the ${lean} would skip:`, '', ...(ran.length > 0 ? ran : ['- (none: every such lane skipped on this run)'])];
    lines.push('', `Its own checks (\`release-pr\`), run here:`, '', ...checks.map((c) => `- \`${c.script}\`: ${c.ok ? 'pass' : `FAIL: ${c.tail}`}`));
    if (failed.length > 0) lines.push('', `⚠️ The ${lean} would defer a failure to the merge queue: ${failed.join(', ')}.`);
    if (checksFailed.length > 0) lines.push('', `⚠️ The ${lean} would fail its own checks: ${checksFailed.join(', ')}.`);
    if (failed.length === 0 && checksFailed.length === 0) lines.push('', `None of them failed. The ${lean} would reach the same verdict.`);
    return { ok: true, lines };
  }
  const lines = [`Release lane full: ${d.reason}.`];
  if (d.lane === 'lean') lines.push('⚠️ The decision re-derives as lean, but `changes` published no lean lane (the decision step failed or is missing), so every lane ran.');
  return { ok: true, lines };
}

/** Output lines without Node's own warnings and crash banner. */
const signalLines = (s) => String(s ?? '').split('\n').filter((l) => l.trim() && !/^\(node:\d+\) (\[\w+\] )?\w*Warning:|^\(Use `node --trace-|^Node\.js v\d/.test(l));

/** Runs LEAN_CHECKS in `cwd`, as `release-pr` would, each with one line of its output. */
export function runLeanChecks(cwd, scripts = LEAN_CHECKS) {
  return scripts.map((script) => {
    // Bounded well inside the aggregate's 5-minute budget; each takes well under a second.
    const r = boundedSpawnSync(process.execPath, [script], { cwd, encoding: 'utf8', timeout: 30_000 });
    if (r.error) return { script, ok: false, tail: r.error.message };
    const stderr = signalLines(r.stderr);
    const out = [...signalLines(r.stdout), ...stderr];
    // A crash's error line says more than the stack under it.
    const errorLine = r.status !== 0 ? stderr.find((l) => /^\w*Error\b.*:/.test(l)) : undefined;
    return { script, ok: r.status === 0, tail: errorLine ?? out.at(-1) ?? '' };
  });
}

function gitReader(cwd) {
  const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return {
    entries: () => git(['diff', '--no-renames', '--name-status', 'HEAD~1', 'HEAD']).split('\n').filter(Boolean).map((l) => {
      const [status, path] = l.split('\t');
      return { status: status[0], path };
    }),
    show: (rev, path) => git(['show', `${rev}:${path}`]),
  };
}

export function run(argv, env = process.env, cwd = process.cwd()) {
  const git = gitReader(cwd);
  const input = {
    event: env.GITHUB_EVENT_NAME,
    mode: env.CI_RELEASE_LANE,
    headRef: env.HEAD_REF,
    headRepo: env.HEAD_REPO,
    repo: env.REPO,
    baseRef: env.BASE_REF,
    labels: env.PR_LABELS,
    draft: env.PR_DRAFT,
    mergify: () => readFileSync(`${cwd}/.mergify.yml`, 'utf8'),
    diff: () => diffProblems(git.entries(), git),
  };
  if (argv[0] === '--decide') {
    const d = decideReleaseLane(input);
    if (d.warning) console.log(`::warning::${d.warning}`);
    console.log(`[ci-release-lane] lane=${d.lane} mode=${d.mode}: ${d.reason}`);
    if (!env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is not set; refusing to decide into nowhere');
    appendFileSync(env.GITHUB_OUTPUT, `lane=${d.lane}\n`);
    return 0;
  }
  if (argv[0] === '--verify') {
    const v = verifyReleaseLane({ ...input, lane: env.LANE, needs: env.NEEDS, runChecks: () => runLeanChecks(cwd) });
    for (const l of v.lines) console.log(l);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${v.lines.join('\n')}\n`);
    return v.ok ? 0 : 1;
  }
  throw new Error('one of --decide or --verify is required');
}

if (isMainEntry(import.meta.url)) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (err) {
    console.error(`[ci-release-lane] ERROR: ${err.message}`);
    process.exitCode = 1;
  }
}
