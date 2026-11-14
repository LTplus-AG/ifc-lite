/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Does .mergify.yml route the release PR (`changeset-release/main`) only
 * through a queue that runs the full gate? The lean lane of
 * scripts/ci-release-lane.mjs is sound only if it does. Node builtins only:
 * it runs in `changes`, before any install.
 */

export const RELEASE_HEAD_REF = 'changeset-release/main';

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
 * Top-level .mergify.yml keys this module accounts for: the two rule lists
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
 * `{ unknown }` for the first one this module cannot judge, else what is
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
 *    before a direct merge. The owner accepted that risk (OWNER_ALLOWS_LEAN in
 *    scripts/ci-release-lane.mjs).
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
