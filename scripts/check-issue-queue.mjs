#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Steering gate: a PR from outside the maintainer must be work the maintainer
 * ASKED FOR, or must say out loud that it is not.
 *
 * THE MEASURED PROBLEM, because this gate is a policy and a policy without
 * evidence is a preference. This repository takes roughly half its commits from
 * one AI-driven external contributor. Of his 743 commits, 608 -- 82% -- carry
 * NO linked issue. That is not carelessness: the backlog is empty (19 open, 698
 * all-time), so an agent told to be useful has nothing to be useful ABOUT, and
 * manufactures its own work queue by sweeping the tree for defects. The
 * correlation runs the other way too, and it is the important half: when a
 * filed issue directed him he built FEATURES; undirected, he swept, endlessly,
 * at 27.7 PRs/day. The bottleneck is not throughput and never was. It is that
 * setting direction currently costs one review per PR, and there is no channel
 * that costs less.
 *
 * So this gate makes the cheap channel the only one: a label on an issue.
 *
 * THE RULE, in one sentence. A PR passes when it closes at least one issue
 * carrying `readyLabel`, or when the PR itself carries `escapeLabel`, or when
 * its author is exempt. Everything else fails.
 *
 * ---------------------------------------------------------------------------
 * PART 1 -- LINKED ISSUES COME FROM `closingIssuesReferences`, NEVER FROM THE
 * BODY, AND THIS REPO HAS ALREADY PAID FOR THAT LESSON.
 *
 *   #2978: the PR body said `Closes ... #2934` on line 1 and, on line 37, "this
 *   NO_LABELS / NO_TIMELINE / NO_CLOSING_ISSUES  A read came back without the
 *                    field it must have. All three are REACHABLE and all three
 *                    are gate bugs rather than contributor errors, so they carry
 *                    the same remedy as the truncation reasons: file it against
 *                    this gate and re-run the job. Named here because a refusal
 *                    with no next action teaches people to ignore refusals.
 *   PR does not close #2934 on its own". Merging would have closed an issue
 *   that stays open. Changing line 1 to `Addresses` was NOT enough --
 *   `closingIssuesReferences` still returned 2934, because GitHub's keyword
 *   scanner matched `close #2934` INSIDE THE SENTENCE DENYING IT. The scanner
 *   has no notion of negation. Only rewording the disclaimer to "#2934 stays
 *   open after this PR" cleared the link.
 *
 *   The direction of that failure is what matters here. A body regex and the
 *   real link DISAGREE, in both directions: the body can name an issue that is
 *   not linked (a disclaimer, a "see also", a changelog quote), and the link
 *   can name an issue the body does not (a closing keyword in a BRANCH COMMIT
 *   MESSAGE, or a maintainer's manual sidebar link, neither of which appears in
 *   the body at all). A gate built on a body regex would therefore both pass
 *   work nobody queued and fail work the maintainer linked by hand.
 *   `closingIssuesReferences` is the field GitHub itself acts on at merge time,
 *   so it is the only field whose answer is the same answer.
 *
 *   `userLinkedOnly: true` -- which would restrict the read to manual sidebar
 *   links -- is deliberately NOT set. A manual link is if anything the STRONGER
 *   steering signal, since only someone with write access can make one, and
 *   excluding body- and commit-derived links would fail the ordinary "Closes
 *   #N" PR this gate is trying to encourage.
 *
 *   AND `gh pr list --search "<n>"` IS NOT AN ALTERNATIVE. AGENTS.md says so
 *   under "Claiming work", in the same words: it "is a TEXT search: it matches
 *   comment bodies, so it both misses linked PRs that never mention the number
 *   and returns unrelated ones that happen to contain it." Nothing below uses
 *   it.
 *
 * ---------------------------------------------------------------------------
 * PART 2 -- WHO APPLIED THE LABEL IS CHECKED, BECAUSE IT IS CHECKABLE.
 *
 *   The obvious hole in "a label only the maintainer applies" is that nothing
 *   makes it so. The contributor this gate is aimed at is a COLLABORATOR
 *   (`authorAssociation` on #3540, measured), which means he can apply labels,
 *   which means he can label his own PR `unqueued` and walk straight through.
 *   Writing that up as a stated hole would have been the easy move.
 *
 *   It is not a hole, because GitHub's timeline carries `LabeledEvent.actor`.
 *   Verified live before this gate was written: issue #3503's `bug` label comes
 *   back as actor `louistrue`, and #3333's `dependencies` and `javascript`
 *   labels come back as actor `dependabot` -- self-applied, on the bot's own
 *   PR, which is exactly the shape being rejected. So `labelAuthorities` in the
 *   config names who may steer, `requireLabelAuthority` turns the rule on, and
 *   a self-applied label is a NAMED FAILURE rather than a silent pass.
 *
 *   THE COST OF READING IT, stated: one extra selection in one GraphQL round
 *   trip, and two new fail-closed paths (an unreadable actor, and a label
 *   history longer than one page). Both are below.
 *
 * ---------------------------------------------------------------------------
 * PART 3 -- WHO IS EXEMPT, AND WHY THAT IS NOT A LOOPHOLE.
 *
 *   The maintainer's own PRs pass unconditionally. He sets direction by
 *   definition; requiring him to file an issue, label it, and close it with his
 *   own PR is ceremony that steers nobody. Bots pass for the opposite reason:
 *   dependabot and the changeset release PR close no issue and never will, and
 *   a gate that reddens every dependency bump is a gate that gets turned off.
 *
 *   THE LOGIN IS NOT ONE STRING, AND THIS BIT ALREADY. On PR #3333, `gh pr
 *   list --json author` says `app/dependabot`, GraphQL's `author { login }`
 *   says `dependabot`, and REST says `dependabot[bot]`. Three spellings, one
 *   actor. `normaliseLogin` folds case, strips a leading `app/` and a trailing
 *   `[bot]`, and the config lists all three anyway so that the file can be
 *   audited by reading it rather than by trusting this paragraph.
 *
 * ---------------------------------------------------------------------------
 * THE TEETH, by failure class, each with its own remedy. Every one of these
 * exits non-zero and names itself.
 *
 *   NO_LINKED_ISSUE   -- the PR closes nothing and carries no escape label.
 *       REMEDY: file the issue, get it labelled `ready`, and add `Closes #N`.
 *       If it genuinely should not wait, ask a maintainer for `unqueued`.
 *
 *   UNQUEUED_WORK     -- the PR closes issues, but none carries `ready`.
 *       REMEDY: ask the maintainer to label one of them. This is the common
 *       case for self-filed sweep issues and it is the case the gate is FOR:
 *       filing an issue for your own sweep and then closing it does not make
 *       the sweep requested.
 *
 *   SELF_APPLIED_LABEL -- the deciding label was applied by someone who is not
 *       a `labelAuthority`.
 *       REMEDY: a maintainer applies it. Re-applying it yourself will produce
 *       this same failure with your login in it.
 *
 *   UNKNOWN_LABEL_APPLIER -- the label is present but no LabeledEvent explains
 *       it (actor deleted, or the event predates what the timeline returns).
 *       REMEDY: remove the label and have a maintainer re-apply it, which
 *       writes a fresh event. Do not "fix" this by turning
 *       `requireLabelAuthority` off in the same PR.
 *
 *   LABELS_TRUNCATED / ISSUES_TRUNCATED / LABEL_HISTORY_TRUNCATED -- the read
 *       hit a page boundary and the answer is therefore not known.
 *       REMEDY: none available to a contributor; this is a gate bug and should
 *       be filed. It is a failure and not a pass because a partial read that
 *       reports success is the defect class this repo keeps rediscovering.
 *
 *   GH_UNAVAILABLE / GH_ERROR / GH_BAD_JSON / GRAPHQL_ERRORS / NO_PULL_REQUEST
 *   / NO_AUTHOR / BAD_CONFIG / NO_CONFIG / BAD_ARGS / NO_REPO -- something
 *       between here and GitHub did not answer.
 *       REMEDY: re-run the job. There is deliberately no branch that prints a
 *       pass over data this gate did not read.
 *
 * ---------------------------------------------------------------------------
 * STATED HOLES. Not caveats -- the things this gate is known not to do, written
 * down so nobody has to discover them by trusting it.
 *
 *   1. IT CANNOT TELL AN URGENT DRIVE-BY FIX FROM UNWANTED WORK. Main is red, a
 *      release is half-published, a crash lands in production: none of that is
 *      visible in `closingIssuesReferences`, and this gate will fail all three
 *      exactly as hard as it fails a cosmetic sweep. THAT IS WHAT `escapeLabel`
 *      IS FOR, and the escape hatch is not an admission of weakness -- a gate
 *      with no escape gets disabled the first time it is wrong, and a disabled
 *      gate steers nothing. The cost is that the escape is a human decision
 *      taken per PR, which is the very cost this gate exists to reduce. It is
 *      a smaller cost than reviewing 27.7 PRs a day, not zero.
 *
 *   2. THE ESCAPE LABEL IS ONLY AS STRONG AS `requireLabelAuthority`. With it
 *      ON (the shipped default) a contributor cannot self-escape: the actor is
 *      read from the timeline and a non-authority is SELF_APPLIED_LABEL. With
 *      it OFF the gate is advisory, because anyone with write access can apply
 *      the label to their own PR. The knob is in the config so that turning it
 *      off is a reviewable act rather than a discovery.
 *
 *      AND IT IS STILL DEFEATABLE BY A COLLABORATOR, one level up: someone who
 *      can apply labels can also add themselves to `labelAuthorities`, in this
 *      file, in a PR. What stops that is not this gate -- it is that the edit
 *      is a visible line in a diff, and that `.github/workflows/issue-queue.yml`
 *      has no `paths:` filter, so the PR making the edit is a PR this gate runs
 *      on. A gate cannot outrank the people who can edit it. It can refuse to
 *      let them do it quietly.
 *
 *   3. IT SAYS NOTHING ABOUT WHETHER THE WORK IS ANY GOOD. A `ready` issue
 *      closed by a bad patch passes. This is a routing check, not a review.
 *
 *   4. IT CANNOT SEE THE COMMIT-MESSAGE HALF OF THE LINK UNTIL IT EXISTS.
 *      `closingIssuesReferences` is computed by GitHub from the body AND the
 *      branch's commit messages, so it is correct the moment either exists --
 *      but on a PR opened before the linking commit is pushed, the answer is
 *      legitimately empty and the gate legitimately fails. Re-running after the
 *      push is the remedy, and `synchronize` in the workflow's trigger list
 *      means the re-run is automatic.
 *
 *   5. AN ISSUE CAN BE LABELLED `ready` AND THEN UNLABELLED. The gate reads the
 *      CURRENT label set, so an issue whose label was removed stops passing,
 *      including for a PR that was already green. That is intended -- the
 *      maintainer withdrawing direction should be able to withdraw it -- but it
 *      means green here is a statement about now, not a permanent grant.
 *
 *   6. THE 100-EVENT TIMELINE WINDOW IS A WINDOW. `labelApplier` reads the
 *      newest 100 LabeledEvents. Past that it fails closed
 *      (LABEL_HISTORY_TRUNCATED) rather than guessing, and the busiest issue in
 *      this repository has ONE. If that ever changes, the fix is pagination,
 *      not a wider guess.
 *
 * ---------------------------------------------------------------------------
 * WIRED BY `.github/workflows/issue-queue.yml`, which carries no `paths:`
 * filter for the reason that workflow's own header sets out at length, copied
 * from `.github/workflows/pr-review-signal.yml`: a gate whose input can be
 * filtered out of its own trigger is the defect it is trying to catch. Its
 * regression harness is `scripts/check-issue-queue.test.mjs`, run in the same
 * job, before the gate.
 *
 * Usage:
 *   node scripts/check-issue-queue.mjs --pr 3540 --repo LTplus-AG/ifc-lite
 *   node scripts/check-issue-queue.mjs --pr 3540 --dump /tmp/pr.json
 *   node scripts/check-issue-queue.mjs --state-file /tmp/pr.json   # offline
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainEntry } from './lib/is-main-entry.mjs';
import { existsOrThrow } from './lib/exists-or-throw.mjs';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = join(SCRIPTS_DIR, 'issue-queue.config.json');

/** A named, actionable refusal. Every exit path below carries one. */
export class IssueQueueError extends Error {
  /** @param {string} reason @param {string} message */
  constructor(reason, message) {
    super(message);
    this.reason = reason;
    this.name = 'IssueQueueError';
  }
}

// ---------------------------------------------------------------- identity

/**
 * One actor, three spellings, one key.
 *
 * Measured on PR #3333: `gh pr list --json author` says `app/dependabot`,
 * GraphQL's `author { login }` on the same PR says `dependabot`, and REST says
 * `dependabot[bot]`. A config listing one spelling would be silently inert
 * against the other two -- and "silently inert" is how an exemption nobody
 * notices becomes an exemption nobody has.
 *
 * @param {unknown} login
 * @returns {string | null} the folded key, or null if there was no login.
 */
export function normaliseLogin(login) {
  if (typeof login !== 'string') return null;
  const trimmed = login.trim().toLowerCase();
  if (trimmed === '') return null;
  return trimmed.replace(/^app\//, '').replace(/\[bot\]$/, '');
}

// ------------------------------------------------------------------ config

/** @param {string} path */
export function readConfig(path) {
  // existsOrThrow: an unreadable config (EACCES, ENOTDIR) must not report as a
  // MISSING one, because the two have different remedies and only one of them
  // is 'create the file'.
  if (!existsOrThrow(path, 'the issue-queue config', (m) => { throw new IssueQueueError('BAD_CONFIG', m); })) {
    throw new IssueQueueError(
      'NO_CONFIG',
      `Config \`${path}\` is missing. A missing label name is NOT an empty one: with no ` +
        '`readyLabel` this gate would compare every issue against `undefined`, match nothing, ' +
        'and fail every PR in the repository for a reason that is about the config rather than ' +
        'about the work.',
    );
  }
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new IssueQueueError('BAD_CONFIG', `Config \`${path}\` is not valid JSON: ${err.message}`);
  }

  for (const key of ['readyLabel', 'escapeLabel']) {
    if (typeof cfg[key] !== 'string' || cfg[key].trim() === '') {
      throw new IssueQueueError(
        'BAD_CONFIG',
        `\`${key}\` in \`${path}\` must be a non-empty string; found ` +
          `${JSON.stringify(cfg[key])}.`,
      );
    }
  }
  // COMPARED CASE-INSENSITIVELY, because label MATCHING is. Once both lookups
  // fold case, `ready` and `Ready` are the same label to this gate, so a
  // case-sensitive equality check here would wave through exactly the collapse
  // the message below warns about.
  if (String(cfg.readyLabel).toLowerCase() === String(cfg.escapeLabel).toLowerCase()) {
    throw new IssueQueueError(
      'BAD_CONFIG',
      `\`readyLabel\` and \`escapeLabel\` in \`${path}\` are both ` +
        `${JSON.stringify(cfg.readyLabel)} and ${JSON.stringify(cfg.escapeLabel)}, which this ` +
        'gate matches case-insensitively and therefore treats as one label. They are applied ' +
        'to different objects -- one to an ' +
        'ISSUE to queue it, one to a PULL REQUEST to bypass the queue -- and collapsing them ' +
        'into one word means a contributor who can label their own PR has also granted ' +
        'themselves the queue.',
    );
  }
  // NOT defaulted, on purpose. `undefined` is falsy, so a typo in this key
  // would silently downgrade the gate to advisory -- which is the exact
  // difference between hole (2) being closed and being open.
  // `mode` is NOT defaulted in code, for the reason every other knob in this
  // config is not: a missing value must be a refusal, never a silent choice of
  // the weaker behaviour. Defaulting to 'advisory' would mean a corrupted config
  // downgrades the gate to a no-op and prints ticks while doing it.
  if (cfg.mode !== 'advisory' && cfg.mode !== 'enforcing') {
    throw new IssueQueueError(
      'BAD_CONFIG',
      `\`mode\` in \`${path}\` must be "advisory" or "enforcing"; found ` +
        `${JSON.stringify(cfg.mode)}. Advisory prints the same verdict and exits 0; ` +
        'enforcing exits 1. There is no default: a missing mode is a broken config, ' +
        'not a request for the lenient one.',
    );
  }
  if (typeof cfg.requireLabelAuthority !== 'boolean') {
    throw new IssueQueueError(
      'BAD_CONFIG',
      `\`requireLabelAuthority\` in \`${path}\` must be true or false; found ` +
        `${JSON.stringify(cfg.requireLabelAuthority)}. It is not defaulted on purpose: a missing ` +
        'key reads as falsy, and a falsy value here turns the self-applied-label rule off ' +
        'without anyone deciding to.',
    );
  }
  if (!Array.isArray(cfg.labelAuthorities)) {
    throw new IssueQueueError(
      'BAD_CONFIG',
      `\`labelAuthorities\` in \`${path}\` must be an array of logins.`,
    );
  }
  if (cfg.requireLabelAuthority && cfg.labelAuthorities.length === 0) {
    throw new IssueQueueError(
      'BAD_CONFIG',
      `\`requireLabelAuthority\` is true but \`labelAuthorities\` in \`${path}\` is empty. Every ` +
        'label would then be self-applied by definition and no PR could ever pass on a label. ' +
        'That is not a strict gate, it is a broken one.',
    );
  }
  if (!Array.isArray(cfg.exemptLogins)) {
    throw new IssueQueueError(
      'BAD_CONFIG',
      `\`exemptLogins\` in \`${path}\` must be an array of logins (it may be empty).`,
    );
  }
  for (const [key, list] of [
    ['labelAuthorities', cfg.labelAuthorities],
    ['exemptLogins', cfg.exemptLogins],
  ]) {
    for (const entry of list) {
      if (normaliseLogin(entry) === null) {
        throw new IssueQueueError(
          'BAD_CONFIG',
          `\`${key}\` in \`${path}\` contains ${JSON.stringify(entry)}, which is not a login.`,
        );
      }
    }
  }

  return {
    readyLabel: cfg.readyLabel,
    escapeLabel: cfg.escapeLabel,
    // Carried through DELIBERATELY. This return is an explicit allowlist, not a
    // spread, so a key validated above but omitted here reads as `undefined` at
    // the call site while the validation still passes -- the gate then behaves as
    // though the knob were unset and nothing says so. `mode` was added and lost
    // exactly that way once; the advisory branch never fired and the only symptom
    // was a correct-looking exit 1.
    mode: cfg.mode,
    requireLabelAuthority: cfg.requireLabelAuthority,
    labelAuthorities: new Set(cfg.labelAuthorities.map(normaliseLogin)),
    exemptLogins: new Set(cfg.exemptLogins.map(normaliseLogin)),
  };
}

// ------------------------------------------------------------------- args

/** @param {string[]} argv */
export function parseArgs(argv) {
  const out = { pr: null, repo: null, config: DEFAULT_CONFIG, stateFile: null, dump: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[(i += 1)];
    if (a === '--pr') out.pr = next();
    else if (a === '--repo') out.repo = next();
    else if (a === '--config') out.config = next();
    else if (a === '--state-file') out.stateFile = next();
    else if (a === '--dump') out.dump = next();
    else throw new IssueQueueError('BAD_ARGS', `Unknown argument \`${a}\`.`);
  }
  return out;
}

// ---------------------------------------------------------------- GraphQL

/**
 * ONE round trip, and every field it selects is load-bearing.
 *
 * `closingIssuesReferences` is the whole of part 1 -- see the header for why
 * the PR body is not evidence. `timelineItems(itemTypes:[LABELED_EVENT])` with
 * `actor` is the whole of part 2. Every connection also selects `pageInfo`,
 * because a truncated read that reports success is the failure mode this repo
 * keeps paying for: a page boundary must look DIFFERENT from an empty answer,
 * and here it does -- it is a named non-zero exit.
 *
 * `last: 100` on the timelines, not `first`: the NEWEST LabeledEvent for a
 * label is the one that put it there, and with `last` the newest is on the page
 * we read. `first` would return the OLDEST hundred, so on any relabelled issue
 * the gate would attribute the current label to whoever applied a long-removed
 * one.
 */
export const PR_QUERY = `
query($owner:String!, $name:String!, $number:Int!) {
  repository(owner:$owner, name:$name) {
    pullRequest(number:$number) {
      number
      title
      author { login }
      labels(first:100) { pageInfo { hasNextPage } nodes { name } }
      timelineItems(last:100, itemTypes:[LABELED_EVENT]) {
        pageInfo { hasPreviousPage }
        nodes { ... on LabeledEvent { label { name } actor { login } createdAt } }
      }
      closingIssuesReferences(first:50) {
        pageInfo { hasNextPage }
        nodes {
          number title state
          labels(first:100) { pageInfo { hasNextPage } nodes { name } }
          timelineItems(last:100, itemTypes:[LABELED_EVENT]) {
            pageInfo { hasPreviousPage }
            nodes { ... on LabeledEvent { label { name } actor { login } createdAt } }
          }
        }
      }
    }
  }
}`;

/**
 * `gh api graphql`, fail-closed. Anything but a clean exit and parseable JSON
 * with no `errors` array is an error with its own reason, never an empty
 * result: an unread PR is not an unqueued PR and it is not a queued one either.
 *
 * @param {{ repo: string, pr: string }} opts
 */
function fetchPayload(opts) {
  const slash = opts.repo.indexOf('/');
  if (slash <= 0 || slash === opts.repo.length - 1) {
    throw new IssueQueueError(
      'NO_REPO',
      `\`${opts.repo}\` is not \`owner/name\`. Guessing would mean adjudicating a repository ` +
        'this gate never confirmed.',
    );
  }
  const number = Number(opts.pr);
  if (!Number.isInteger(number) || number <= 0) {
    throw new IssueQueueError(
      'BAD_ARGS',
      `\`--pr\` needs a positive integer; got ${JSON.stringify(opts.pr)}. The GraphQL variable is ` +
        'typed `Int!`, so a non-numeric value is a server-side error rather than a local one, ' +
        'and the failure would read as a GitHub outage.',
    );
  }
  const args = [
    'api',
    'graphql',
    '-f',
    `query=${PR_QUERY}`,
    '-f',
    `owner=${opts.repo.slice(0, slash)}`,
    '-f',
    `name=${opts.repo.slice(slash + 1)}`,
    '-F',
    `number=${number}`,
  ];
  const r = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (r.error) {
    throw new IssueQueueError(
      'GH_UNAVAILABLE',
      `Could not spawn \`gh\` to read PR #${opts.pr}: ${r.error.message}. Without it this gate ` +
        'cannot see the issue links, and unseen links are not absent ones.',
    );
  }
  let parsed = null;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    parsed = null;
  }
  // ORDER MATTERS: `gh` exits non-zero on a GraphQL error but still prints the
  // `errors` array, and that array says WHICH field failed. Reporting the exit
  // code alone would turn "you lack `pull-requests: read`" into "gh exited 1".
  const errors = parsed && Array.isArray(parsed.errors) ? parsed.errors : null;
  if (errors && errors.length > 0) {
    throw new IssueQueueError(
      'GRAPHQL_ERRORS',
      `GitHub's GraphQL API returned ${errors.length} error(s) for PR #${opts.pr}: ` +
        errors.map((e) => e?.message ?? JSON.stringify(e)).join('; '),
    );
  }
  if (r.status !== 0) {
    throw new IssueQueueError(
      'GH_ERROR',
      `\`gh api graphql\` exited ${r.status} reading PR #${opts.pr}: ` +
        `${(r.stderr || '').trim() || '(no stderr)'}. A permissions failure and a PR that closes ` +
        'nothing are indistinguishable from the exit code alone, so this fails.',
    );
  }
  if (parsed === null) {
    throw new IssueQueueError(
      'GH_BAD_JSON',
      `\`gh api graphql\` returned unparseable output reading PR #${opts.pr}.`,
    );
  }
  return parsed;
}

// ------------------------------------------------------------ normalising

/**
 * The newest actor to have applied `label`, out of a LabeledEvent timeline.
 *
 * Three outcomes, and they are three because two would lose the one that
 * matters: `{ applier }` when an event explains the label, `{ applier: null,
 * truncated: false }` when no event does (a deleted actor, or a label applied
 * before the timeline this read covers), and `{ applier: null, truncated: true
 * }` when the page boundary means the answer is simply not known. Only the
 * first may lead to a pass.
 *
 * @param {{ nodes: unknown[], truncated: boolean }} timeline
 * @param {string} label
 */
export function labelApplier(timeline, label) {
  // Newest-last, because the query asks for `last:100`. Walking backwards
  // finds the event that put the CURRENT label there, not a removed ancestor.
  for (let i = timeline.nodes.length - 1; i >= 0; i -= 1) {
    const node = timeline.nodes[i];
    // Case-folded, for the same reason the presence check above is: a label
    // created as `Ready` must resolve to the same event as one created as
    // `ready`, or the label is FOUND and its applier is not, which reports
    // UNKNOWN_LABEL_APPLIER on a label a maintainer plainly applied.
    if (String(node?.label?.name ?? '').toLowerCase() !== String(label).toLowerCase()) continue;
    const applier = normaliseLogin(node?.actor?.login);
    // An event with no readable actor is not evidence of authority, so the
    // walk STOPS here rather than falling through to an older event by a
    // different actor. The older event did not apply this label.
    return { applier, truncated: false, at: node?.createdAt ?? null };
  }
  return { applier: null, truncated: timeline.truncated, at: null };
}

/** @param {unknown} conn @param {string} what */
function labelSet(conn, what) {
  const nodes = Array.isArray(conn?.nodes) ? conn.nodes : null;
  if (nodes === null) {
    throw new IssueQueueError(
      'NO_LABELS',
      `${what} returned no label list at all. Refusing to read a missing list as an empty one.`,
    );
  }
  if (conn?.pageInfo?.hasNextPage === true) {
    throw new IssueQueueError(
      'LABELS_TRUNCATED',
      `${what} carries more than 100 labels, so this gate did not read all of them and cannot ` +
        'say whether the deciding label is among them. This is a gate bug (the fix is ' +
        'pagination), not something a contributor can act on -- but a partial read that ' +
        'reported success would be worse.',
    );
  }
  return nodes.map((n) => n?.name).filter((n) => typeof n === 'string');
}

/** @param {unknown} conn @param {string} what */
function timelineOf(conn, what) {
  const nodes = Array.isArray(conn?.nodes) ? conn.nodes : null;
  if (nodes === null) {
    throw new IssueQueueError(
      'NO_TIMELINE',
      `${what} returned no label history. Refusing to read a missing history as "nobody applied ` +
        'anything".',
    );
  }
  return { nodes, truncated: conn?.pageInfo?.hasPreviousPage === true };
}

/**
 * A raw GraphQL payload into the shape `evaluate` adjudicates.
 *
 * Pure, so the harness can drive it over payloads captured from the live API via
 * `--dump` and replayed with `--state-file` -- the parser and the policy are both
 * under test, rather than the policy over a hand-rolled shape the parser never
 * sees. The harness drives this as a SUBPROCESS (real argv, real config reads,
 * real exit codes), not by importing it; the `export` keeps it addressable for a
 * future in-process caller and is not evidence that one exists today.
 *
 * @param {unknown} payload
 */
export function normalisePullRequest(payload) {
  if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
    throw new IssueQueueError(
      'GRAPHQL_ERRORS',
      `Payload carries ${payload.errors.length} GraphQL error(s): ` +
        payload.errors.map((e) => e?.message ?? JSON.stringify(e)).join('; '),
    );
  }
  const pr = payload?.data?.repository?.pullRequest;
  if (!pr || typeof pr !== 'object') {
    throw new IssueQueueError(
      'NO_PULL_REQUEST',
      'The payload has no `data.repository.pullRequest`. GitHub returns `null` there for a PR ' +
        'this token cannot see as well as for one that does not exist, and neither is a PR that ' +
        'passed.',
    );
  }
  const author = normaliseLogin(pr.author?.login);
  if (author === null) {
    // GitHub nulls `author` for a deleted account. Everything below is scoped
    // by identity -- exemption, and who applied the label -- so an unknown
    // author is an unanswerable question, not an unexempt one.
    throw new IssueQueueError(
      'NO_AUTHOR',
      `PR #${pr.number ?? '(unknown)'} has no readable author login. Exemption and label ` +
        'authority are both identity questions, and neither can be answered over a null actor.',
    );
  }

  const issuesConn = pr.closingIssuesReferences;
  if (!Array.isArray(issuesConn?.nodes)) {
    throw new IssueQueueError(
      'NO_CLOSING_ISSUES',
      `PR #${pr.number} returned no \`closingIssuesReferences\` list at all. An absent list and ` +
        'an empty one are different answers: the first means the read failed, and this gate ' +
        'never converts a failed read into "closes nothing".',
    );
  }
  if (issuesConn.pageInfo?.hasNextPage === true) {
    throw new IssueQueueError(
      'ISSUES_TRUNCATED',
      `PR #${pr.number} closes more than 50 issues, so this gate did not read all of them. It ` +
        'will not report "none of them is ready" over a list it did not finish.',
    );
  }

  return {
    number: pr.number,
    title: typeof pr.title === 'string' ? pr.title : '',
    author,
    labels: labelSet(pr.labels, `PR #${pr.number}`),
    labelHistory: timelineOf(pr.timelineItems, `PR #${pr.number}`),
    issues: issuesConn.nodes.map((issue) => ({
      number: issue?.number,
      title: typeof issue?.title === 'string' ? issue.title : '',
      state: typeof issue?.state === 'string' ? issue.state : '(unknown)',
      labels: labelSet(issue?.labels, `Issue #${issue?.number}`),
      labelHistory: timelineOf(issue?.timelineItems, `Issue #${issue?.number}`),
    })),
  };
}

// ------------------------------------------------------------- the verdict

/**
 * Adjudicate one label as a steering signal.
 *
 * @returns {{ ok: boolean, reason: string | null, applier: string | null, at: string | null }}
 */
function adjudicateLabel(holder, label, cfg) {
  // Case-folded on BOTH sides, for the reason normaliseLogin exists. GitHub
  // labels are case-preserving and a maintainer creating `ready` through the web
  // UI can easily land `Ready`. Matched case-sensitively, every non-exempt PR
  // then fails reporting "#N has no `ready` label (it has: Ready)" -- a remedy
  // that has already been performed, which is the worst kind of failure message.
  const wanted = String(label).toLowerCase();
  if (!holder.labels.some((l) => String(l).toLowerCase() === wanted)) {
    return { ok: false, reason: 'ABSENT', applier: null, at: null };
  }
  if (!cfg.requireLabelAuthority) {
    return { ok: true, reason: 'UNCHECKED', applier: null, at: null };
  }
  const { applier, truncated, at } = labelApplier(holder.labelHistory, label);
  if (applier === null) {
    return {
      ok: false,
      reason: truncated ? 'LABEL_HISTORY_TRUNCATED' : 'UNKNOWN_LABEL_APPLIER',
      applier: null,
      at: null,
    };
  }
  if (!cfg.labelAuthorities.has(applier)) {
    return { ok: false, reason: 'SELF_APPLIED_LABEL', applier, at };
  }
  return { ok: true, reason: 'AUTHORISED', applier, at };
}

/**
 * The whole check over data already fetched. Split out so `--state-file` can
 * reach every branch -- including every fail-closed one -- without a network, a
 * token, or a real PR, and so that the SAME function runs in CI as runs there.
 * The harness reaches it through that flag, not through an import.
 *
 * @param {{ pr: ReturnType<typeof normalisePullRequest>, cfg: ReturnType<typeof readConfig> }} args
 * @returns {{ ok: boolean, verdict: string, escapeProblem: string|null, lines: string[] }}
 */
export function evaluate({ pr, cfg }) {
  const lines = [];

  // ---- exempt authors, first, because the rest of the gate does not apply.
  if (cfg.exemptLogins.has(pr.author)) {
    lines.push(
      `ℹ️  EXEMPT_AUTHOR: \`${pr.author}\` is in \`exemptLogins\`, so this PR is not adjudicated.`,
      '   The maintainer sets direction by definition, and a bot has no work queue to steer.',
    );
    return { ok: true, verdict: 'EXEMPT_AUTHOR', escapeProblem: null, lines };
  }

  // ---- the escape hatch.
  const escape = adjudicateLabel(pr, cfg.escapeLabel, cfg);
  if (escape.ok) {
    lines.push(
      `✅ ESCAPE_LABEL: this PR carries \`${cfg.escapeLabel}\`` +
        (escape.applier ? `, applied by \`${escape.applier}\`` : '') +
        (escape.at ? ` at ${escape.at}` : '') +
        ', so the queue is bypassed deliberately.',
      '   This gate cannot tell an urgent drive-by fix from unwanted work — that judgement is ' +
        'the label, and it is a human one.',
    );
    return { ok: true, verdict: 'ESCAPE_LABEL', escapeProblem: null, lines };
  }
  // A BAD ESCAPE LABEL MUST NOT FAIL A PR THE QUEUE CHECK WOULD PASS.
  //
  // This block used to `return { ok: false }` here, before `pr.issues` was ever
  // read. A contributor who optimistically added `unqueued` to a PR that ALREADY
  // closed a `ready` issue got a red check, and the printed remedy ("a maintainer
  // applies it") was the wrong fix: the PR was properly queued and the correct
  // action was to remove the label. The escape hatch is a way to PASS something
  // the queue would refuse; it can never be the reason a queued PR fails.
  //
  // So a failed escape is remembered, not returned. If the queue check passes,
  // the PR passes and the bad label is reported as a note. If the queue check
  // also fails, both are reported, because then the escape is the route the
  // contributor was actually trying to take and its remedy is the useful one.
  const escapeProblem =
    escape.reason === 'SELF_APPLIED_LABEL'
      ? [
          `⚠️  SELF_APPLIED_LABEL: this PR carries \`${cfg.escapeLabel}\`, but it was applied by ` +
            `\`${escape.applier}\`, who is not in \`labelAuthorities\`.`,
          '   An escape label the author applies to their own PR is not an escape hatch, it is ' +
            'the absence of a gate.',
          '   REMEDY: a maintainer applies it. Re-applying it yourself reproduces this with your ' +
            'login in it.',
        ]
      : escape.reason === 'UNKNOWN_LABEL_APPLIER' || escape.reason === 'LABEL_HISTORY_TRUNCATED'
        ? [
            `⚠️  ${escape.reason}: this PR carries \`${cfg.escapeLabel}\`, but no readable ` +
              'LabeledEvent says who applied it' +
              (escape.reason === 'LABEL_HISTORY_TRUNCATED'
                ? ' within the newest 100 label events.'
                : '.'),
            '   A label with no author is not evidence of authority. REMEDY: remove it and have ' +
              'a maintainer re-apply it.',
          ]
        : null;

  if (pr.issues.length === 0) {
    lines.push(
      // Conditional on escapeProblem: the PR may well CARRY the escape label and
      // have it rejected below. Saying "carries no `unqueued` label" while the
      // same output prints "this PR carries `unqueued`, but ..." is a
      // self-contradicting message, and the header line already printed the label.
      escapeProblem
        ? `❌ NO_LINKED_ISSUE: this PR closes no issue, and its \`${cfg.escapeLabel}\` label ` +
          'does not authorise the bypass (see below).'
        : '❌ NO_LINKED_ISSUE: this PR closes no issue, and carries no ' +
          `\`${cfg.escapeLabel}\` label.`,
      '   Read from `closingIssuesReferences`, which is the field GitHub itself acts on at ' +
        'merge time — NOT from the PR body.',
      '   A body regex disagrees with the real link in both directions: #2978 had a DISCLAIMER ' +
        'sentence ("this PR does',
      '   not close #2934") that GitHub\'s keyword scanner read as a closing link, and a link ' +
        'can equally come from a',
      '   branch commit message or a maintainer\'s manual sidebar link, neither of which is in ' +
        'the body at all.',
      '   REMEDY: file the issue, ask for the `' +
        cfg.readyLabel +
        '` label, and add `Closes #N` to this PR. If it genuinely',
      `   cannot wait, ask a maintainer for \`${cfg.escapeLabel}\`.`,
      '   If you pushed the linking commit after opening this PR, re-run: the link appears when ' +
        'the commit does.',
    );
    if (escapeProblem) lines.push('', ...escapeProblem);
    // The PRIMARY failure is the verdict; the escape problem is carried in
    // `lines`. Returning escape.reason here made the field disagree with the
    // banner, which nothing reads today and a future job-summary step would.
    // `escape.reason` is 'ABSENT' when the PR simply carries no escape label,
    // which is the COMMON case and not a problem. Reporting it here put a
    // truthy value on the field for every ordinary failure, re-creating the
    // banner/field contradiction that moving this off `verdict` removed.
    return { ok: false, verdict: 'NO_LINKED_ISSUE', escapeProblem: escapeProblem ? escape.reason : null, lines };
  }

  const verdicts = pr.issues.map((issue) => ({
    issue,
    ...adjudicateLabel(issue, cfg.readyLabel, cfg),
  }));
  const queued = verdicts.filter((v) => v.ok);
  if (queued.length > 0) {
    for (const v of queued) {
      lines.push(
        `✅ READY_ISSUE: closes #${v.issue.number} (${v.issue.state}), which carries ` +
          `\`${cfg.readyLabel}\`` +
          (v.applier ? `, applied by \`${v.applier}\`` : '') +
          (v.at ? ` at ${v.at}` : '') +
          '.',
      );
      lines.push(`      ${v.issue.title}`);
    }
    if (queued.length < verdicts.length) {
      lines.push(
        `   ${verdicts.length - queued.length} other linked issue(s) are not queued; one ready ` +
          'issue is enough.',
      );
    }
    if (escapeProblem) {
      lines.push('', ...escapeProblem, '   This PR passes on its `ready` issue regardless.');
    }
    return { ok: true, verdict: 'READY_ISSUE', escapeProblem: escapeProblem ? escape.reason : null, lines };
  }

  // Every linked issue failed. Name each one WITH ITS OWN reason: "none is
  // ready" and "one is ready but you labelled it yourself" have different
  // remedies, and collapsing them would send a contributor to the wrong one.
  lines.push(
    `❌ UNQUEUED_WORK: this PR closes ${verdicts.length} issue(s), and not one of them carries a ` +
      `\`${cfg.readyLabel}\` label from an authorised labeller.`,
  );
  for (const v of verdicts) {
    if (v.reason === 'SELF_APPLIED_LABEL') {
      lines.push(
        `      - #${v.issue.number} carries \`${cfg.readyLabel}\`, but \`${v.applier}\` applied ` +
          'it and is not in `labelAuthorities`.',
      );
    } else if (v.reason === 'LABEL_HISTORY_TRUNCATED' || v.reason === 'UNKNOWN_LABEL_APPLIER') {
      lines.push(
        `      - #${v.issue.number} carries \`${cfg.readyLabel}\`, but no readable event says ` +
          `who applied it (${v.reason}).`,
      );
    } else {
      lines.push(
        `      - #${v.issue.number} has no \`${cfg.readyLabel}\` label` +
          (v.issue.labels.length > 0 ? ` (it has: ${v.issue.labels.join(', ')})` : ' (no labels)') +
          '.',
      );
    }
  }
  lines.push(
    '   Filing an issue for your own sweep and then closing it does not make the sweep ' +
      'requested. The label is the request.',
    `   REMEDY: ask the maintainer to label one of these \`${cfg.readyLabel}\`, or to label this ` +
      `PR \`${cfg.escapeLabel}\` if it should not wait.`,
    '',
    '   NOTE: labelling an ISSUE does not re-run this check. It fires the `issues` event and ' +
      'this workflow listens to `pull_request`, so the row stays stale until this PR is pushed ' +
      'to, edited, relabelled, or re-run by hand.',
  );
  if (escapeProblem) lines.push('', ...escapeProblem);
  return { ok: false, verdict: 'UNQUEUED_WORK', escapeProblem: escapeProblem ? escape.reason : null, lines };
}

// -------------------------------------------------------------------- main

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = readConfig(args.config);
  // PRINTED AS EARLY AS IT CAN BE, which is after readConfig -- the mode is read
  // FROM that config, so `parseArgs` and `readConfig` refusals (BAD_ARGS,
  // BAD_CONFIG, NO_CONFIG) necessarily print no mode line. That is a stated
  // limit, not a closed hole: those two are broken-invocation errors, not
  // verdicts on a PR, and a contributor never triggers them.
  // CONTRIBUTING.md and the PR template point readers at this line instead of
  // restating the mode, so it has to survive the fail-closed paths too: every
  // throw in normalisePullRequest (NO_AUTHOR on a deleted account,
  // ISSUES_TRUNCATED, NO_CLOSING_ISSUES, a truncated label page) exits 1 even in
  // advisory mode. Printed later, a contributor hitting one of those saw a red
  // check, no mode line, and no document left saying the gate is advisory.
  console.log(
    `Mode: ${cfg.mode}${
      cfg.mode === 'advisory'
        ? ' (a failing VERDICT prints but does not fail this job; a REFUSAL still does)'
        : ''
    }`,
  );

  let payload;
  if (args.stateFile) {
    // Offline mode: a captured GraphQL payload standing in for the read. It
    // goes through the SAME `normalisePullRequest` and the SAME `evaluate` as
    // a live run, so the harness exercises the parser too -- a policy tested
    // over a hand-rolled shape the parser never produces is a policy tested
    // against itself.
    payload = JSON.parse(readFileSync(args.stateFile, 'utf8'));
  } else {
    if (!args.pr) {
      throw new IssueQueueError('BAD_ARGS', 'Pass `--pr <number>` (or `--state-file` for tests).');
    }
    const repo = args.repo ?? process.env.GITHUB_REPOSITORY;
    if (!repo) {
      throw new IssueQueueError(
        'NO_REPO',
        'Pass `--repo owner/name` or set GITHUB_REPOSITORY. Guessing it would mean adjudicating ' +
          'a repository this gate never confirmed.',
      );
    }
    payload = fetchPayload({ repo, pr: args.pr });
  }
  if (args.dump) writeFileSync(args.dump, JSON.stringify(payload, null, 2));

  const pr = normalisePullRequest(payload);
  console.log(`PR #${pr.number} by \`${pr.author}\` — ${pr.title}`);
  console.log(`PR labels: ${pr.labels.length > 0 ? pr.labels.join(', ') : '(none)'}`);
  console.log(
    `Closing issue references: ${
      pr.issues.length > 0 ? pr.issues.map((i) => `#${i.number}`).join(', ') : '(none)'
    }`,
  );
  console.log(
    `Label authority required: ${cfg.requireLabelAuthority} (authorities: ${
      [...cfg.labelAuthorities].join(', ') || '(none)'
    })`,
  );
  console.log('');

  const { ok, lines } = evaluate({ pr, cfg });
  for (const l of lines) console.log(l);

  // ADVISORY GATES THE EXIT CODE AND NOTHING ELSE. The verdict above is printed
  // identically in both modes, so the rollout cannot quietly change what the gate
  // SAYS -- only whether saying it fails the job. That matters because advisory
  // is a transition state: it shipped that way so 30 in-flight PRs from an active
  // contributor did not all turn red on the day the rule arrived, and the flip to
  // enforcing is a one-word config edit reviewed like any other.
  if (!ok && cfg.mode === 'advisory') {
    console.log('');
    console.log(
      'ADVISORY MODE: the finding above does not fail this job. Set `mode` to ' +
        '"enforcing" in scripts/issue-queue.config.json once the queue is stocked.',
    );
    process.exit(0);
  }
  process.exit(ok ? 0 : 1);
}

if (isMainEntry(import.meta.url)) {
  try {
    main();
  } catch (err) {
    if (err instanceof IssueQueueError) {
      console.error(`❌ ${err.reason}: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}
