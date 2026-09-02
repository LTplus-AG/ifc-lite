/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Regression harness for the steering gate, as a PROCESS: real argv, real
 * config reads, real exit codes.
 *
 * THE PAYLOADS ARE GRAPHQL PAYLOADS, not a convenient internal shape. Every
 * fixture below is `{ data: { repository: { pullRequest: ... } } }` with the
 * same `pageInfo`/`nodes` nesting the live API returns, so `normalisePullRequest`
 * is under test alongside `evaluate`. A policy driven over a shape its own
 * parser never produces is a policy tested against itself.
 *
 * `prPayload` is a REDUCTION of a payload captured live from
 * `LTplus-AG/ifc-lite` on 2026-08-30 (PR #3333, dependabot, self-applied labels;
 * PR #3540 -> issue #3525; issue #3503, `bug` applied by `louistrue`). Nothing
 * here touches the network.
 *
 * BOTH DIRECTIONS, DELIBERATELY. A gate is only trustworthy if its pass and its
 * fail are both demonstrated, so every rule below appears twice: once as the
 * shape that passes and once as the nearest shape that does not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, normalisePullRequest, normaliseLogin } from './check-issue-queue.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const GATE = join(HERE, 'check-issue-queue.mjs');
const CONFIG = join(HERE, 'issue-queue.config.json');
const WORKFLOW = join(REPO_ROOT, '.github/workflows/issue-queue.yml');

const TMP = mkdtempSync(join(tmpdir(), 'issue-queue-'));
let seq = 0;

const SHIPPED = JSON.parse(readFileSync(CONFIG, 'utf8'));
/** The shipped config as `evaluate` wants it: Sets, and the rollout pinned. */
const ENFORCING_CFG = {
  ...SHIPPED,
  mode: 'enforcing',
  labelAuthorities: new Set(SHIPPED.labelAuthorities.map(normaliseLogin)),
  exemptLogins: new Set(SHIPPED.exemptLogins.map(normaliseLogin)),
};
const READY = SHIPPED.readyLabel;
const ESCAPE = SHIPPED.escapeLabel;
const MAINTAINER = SHIPPED.labelAuthorities[0];
/** A contributor login: a real collaborator, not in either config list. */
const CONTRIBUTOR = 'BIMvoice';

// -------------------------------------------------------------- fixtures

/**
 * A labels connection plus the LabeledEvent timeline that explains it.
 *
 * The two are built together on purpose: in the live API a label and the event
 * that applied it always arrive together, and a fixture that could hold one
 * without the other would let a test assert a shape GitHub never returns.
 *
 * @param {Array<[string, string | null]>} pairs - [label, applier login or null]
 */
function labelled(pairs, { labelsTruncated = false, historyTruncated = false } = {}) {
  return {
    labels: {
      pageInfo: { hasNextPage: labelsTruncated },
      nodes: pairs.map(([name]) => ({ name })),
    },
    timelineItems: {
      pageInfo: { hasPreviousPage: historyTruncated },
      nodes: pairs
        .filter(([, who]) => who !== null)
        .map(([name, who]) => ({
          label: { name },
          actor: { login: who },
          createdAt: '2026-08-30T09:00:00Z',
        })),
    },
  };
}

function issue(number, pairs, extra = {}) {
  return {
    number,
    title: `issue ${number}`,
    state: 'OPEN',
    ...labelled(pairs, extra),
  };
}

function prPayload({
  number = 3540,
  author = CONTRIBUTOR,
  prLabels = [],
  issues = [],
  issuesTruncated = false,
  prExtra = {},
} = {}) {
  return {
    data: {
      repository: {
        pullRequest: {
          number,
          title: `pull request ${number}`,
          author: author === null ? null : { login: author },
          ...labelled(prLabels, prExtra),
          closingIssuesReferences: {
            pageInfo: { hasNextPage: issuesTruncated },
            nodes: issues,
          },
        },
      },
    },
  };
}

/** Run the gate over a payload EXACTLY as written. */
function run(payload, extra = []) {
  const path = join(TMP, `payload-${(seq += 1)}.json`);
  writeFileSync(path, JSON.stringify(payload));
  const r = spawnSync(process.execPath, [GATE, '--state-file', path, ...extra], {
    encoding: 'utf8',
  });
  return { code: r.status, output: `${r.stdout}${r.stderr}` };
}

/** Write a config variant and return `--config <path>`. */
function cfgWith(patch, tag) {
  const path = join(TMP, `cfg-${tag}.json`);
  // Defaults to `enforcing`, and `patch` can still override it. A verdict test
  // asks "does this shape fail", which is a question about the POLICY; the
  // shipped `mode` is a rollout state that will flip. Without this default,
  // flipping the shipped config silently rewrote what nine tests asserted.
  writeFileSync(path, JSON.stringify({ ...SHIPPED, mode: 'enforcing', ...patch }));
  return ['--config', path];
}

/** The shipped config with the rollout pinned to enforcing. */
const ENFORCING = cfgWith({}, 'enforcing-base');

test('a BAD escape label does not fail a PR the queue check passes', () => {
  // The escape hatch is a way to PASS something the queue would refuse. It must
  // never be the reason a properly queued PR fails. This shipped the other way:
  // `evaluate` adjudicated the escape label before reading `pr.issues` and
  // returned ok:false, so a contributor who optimistically added `unqueued` to a
  // PR that ALREADY closed a `ready` issue got a red check whose remedy ("a
  // maintainer applies it") was the wrong fix -- the right one was to remove it.
  const r = run(
    prPayload({
      prLabels: [[ESCAPE, CONTRIBUTOR]],
      issues: [issue(3525, [[READY, MAINTAINER]])],
    }),
    ENFORCING,
  );
  assert.equal(r.code, 0, r.output);
  assert.match(r.output, /READY_ISSUE/);
  // The bad label is still reported, as a note rather than a verdict.
  assert.match(r.output, /SELF_APPLIED_LABEL/);
  assert.match(r.output, /passes on its `ready` issue regardless/);
});

test('a bad escape label IS the verdict when the queue check also fails', () => {
  const r = run(
    prPayload({ prLabels: [[ESCAPE, CONTRIBUTOR]], issues: [issue(3525, [])] }),
    ENFORCING,
  );
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /UNQUEUED_WORK/);
  assert.match(r.output, /SELF_APPLIED_LABEL/);
});

test('label matching folds case, so `Ready` satisfies `ready`', () => {
  // GitHub labels are case-preserving and a maintainer creating the label in the
  // web UI can easily land `Ready`. Matched case-sensitively, every non-exempt PR
  // would fail reporting "has no `ready` label (it has: Ready)" -- a remedy that
  // has already been performed.
  const r = run(
    prPayload({ issues: [issue(3525, [['Ready', MAINTAINER]])] }),
    ENFORCING,
  );
  assert.equal(r.code, 0, r.output);
  assert.match(r.output, /READY_ISSUE/);
});

test('readyLabel and escapeLabel differing only by CASE are refused', () => {
  // Label matching folds case, so `ready` and `Ready` are one label to this gate.
  // A case-sensitive equality check here would wave through exactly the collapse
  // the refusal message warns about: a contributor who can label their own PR
  // would have granted themselves the queue.
  const r = run(
    prPayload({ issues: [issue(3525, [])] }),
    cfgWith({ readyLabel: 'ready', escapeLabel: 'Ready' }, 'case-collision'),
  );
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /BAD_CONFIG/);
  assert.match(r.output, /case-insensitively/);
});

test('NO_LINKED_ISSUE does not deny a label the same output reports', () => {
  // The banner used to say "carries no `unqueued` label" while the lines below
  // said "this PR carries `unqueued`, but ...", in one output, with the header
  // already printing `PR labels: unqueued`. Three statements, two of them wrong.
  const r = run(
    prPayload({ prLabels: [[ESCAPE, CONTRIBUTOR]], issues: [] }),
    ENFORCING,
  );
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /NO_LINKED_ISSUE/);
  assert.match(r.output, /SELF_APPLIED_LABEL/);
  // Built from ESCAPE, not hardcoded: `escapeLabel` is advertised as a
  // no-code-change knob, and a hardcoded label would make this assertion
  // silently vacuous after a rename -- the test named for the contradiction
  // no longer able to see it.
  assert.doesNotMatch(r.output, new RegExp(`carries no \`${ESCAPE}\` label`));
});

test('escapeProblem is null when there is simply no escape label', () => {
  // ASSERTED THROUGH evaluate() DIRECTLY, not through the output. `escapeProblem`
  // is a RETURN FIELD and is never printed, so an output-based assertion for it
  // is vacuous: the first version of this test passed with the bug fully
  // restored. `evaluate` and `normalisePullRequest` are exported for exactly
  // this, and the payload comes from the same builder the subprocess tests use,
  // so the parser under test is the real one.
  const pr = normalisePullRequest(prPayload({ issues: [issue(3525, [])] }));
  const r = evaluate({ pr, cfg: ENFORCING_CFG });
  assert.equal(r.ok, false);
  assert.equal(r.verdict, 'UNQUEUED_WORK');
  assert.equal(r.escapeProblem, null, 'ABSENT is not a problem, it is the common case');
});

test('a PASSING PR still reports a real escape problem on the field', () => {
  const pr = normalisePullRequest(
    prPayload({
      prLabels: [[ESCAPE, CONTRIBUTOR]],
      issues: [issue(3525, [[READY, MAINTAINER]])],
    }),
  );
  const r = evaluate({ pr, cfg: ENFORCING_CFG });
  assert.equal(r.ok, true);
  assert.equal(r.verdict, 'READY_ISSUE');
  assert.equal(r.escapeProblem, 'SELF_APPLIED_LABEL', 'absent exactly where it matters');
});

test('the Mode line survives a fail-closed refusal', () => {
  // The docs point readers at this line instead of restating the mode, so it has
  // to print before anything that can refuse. Every throw in
  // normalisePullRequest exits 1 even in advisory mode; printed later, a
  // contributor hitting one saw a red check and no statement of the mode.
  const r = run(
    prPayload({ issues: [issue(3525, [])], issuesTruncated: true }),
    cfgWith({ mode: 'advisory' }, 'mode-before-refusal'),
  );
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /^Mode: advisory/m);
});

// =========================================================== advisory mode
//
// These exist because the branch shipped BROKEN and every one of the 33 tests
// stayed green. `readConfig` returns an explicit key allowlist rather than a
// spread, so `mode` was validated on the raw JSON and then dropped from the
// object the gate actually reads: `cfg.mode` was `undefined` at the exit check,
// the advisory branch never ran, and the only symptom was a correct-LOOKING
// exit 1. A knob with no test is a knob that does nothing.

test('ADVISORY: a failing verdict prints in full and exits 0', () => {
  const r = run(
    prPayload({ issues: [issue(3525, [])] }),
    cfgWith({ mode: 'advisory' }, 'advisory-fail'),
  );
  assert.equal(r.code, 0, r.output);
  // The verdict text must be IDENTICAL to enforcing: advisory gates the exit
  // code and nothing else, so a rollout cannot quietly change what is reported.
  assert.match(r.output, /UNQUEUED_WORK/);
  assert.match(r.output, /ADVISORY MODE: the finding above does not fail this job/);
});

test('ENFORCING: the same payload exits 1 and says nothing about advisory', () => {
  const r = run(
    prPayload({ issues: [issue(3525, [])] }),
    cfgWith({ mode: 'enforcing' }, 'enforcing-fail'),
  );
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /UNQUEUED_WORK/);
  assert.doesNotMatch(r.output, /ADVISORY MODE/);
});

test('ADVISORY does not alter a PASS', () => {
  const r = run(
    prPayload({ issues: [issue(3525, [[READY, MAINTAINER]])] }),
    cfgWith({ mode: 'advisory' }, 'advisory-pass'),
  );
  assert.equal(r.code, 0, r.output);
  assert.match(r.output, /READY_ISSUE/);
  assert.doesNotMatch(r.output, /ADVISORY MODE/);
});

test('ADVISORY does not suppress a REFUSAL', () => {
  // A refusal is a fact about the gate's inputs, not a verdict on the PR, so it
  // must fail closed in both modes. Advisory softening these would make a broken
  // config indistinguishable from a clean run.
  const r = run(
    prPayload({ issues: [issue(3525, [])], issuesTruncated: true }),
    cfgWith({ mode: 'advisory' }, 'advisory-refusal'),
  );
  assert.equal(r.code, 1, r.output);
  assert.doesNotMatch(r.output, /ADVISORY MODE/);
});

test('a MISSING mode is refused, not defaulted to the lenient one', () => {
  const path = join(TMP, 'cfg-no-mode.json');
  const { mode, ...withoutMode } = SHIPPED;
  writeFileSync(path, JSON.stringify(withoutMode));
  const r = run(prPayload({ issues: [issue(3525, [])] }), ['--config', path]);
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /BAD_CONFIG/);
  assert.match(r.output, /must be "advisory" or "enforcing"/);
});

test('an UNKNOWN mode is refused', () => {
  const r = run(
    prPayload({ issues: [issue(3525, [])] }),
    cfgWith({ mode: 'warn' }, 'bad-mode'),
  );
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /BAD_CONFIG/);
});

// =================================================== the five core verdicts

test('PASS: a PR closing a `ready` issue', () => {
  const r = run(
    prPayload({ issues: [issue(3525, [[READY, MAINTAINER]])] }),
  );
  assert.equal(r.code, 0, r.output);
  assert.match(r.output, /READY_ISSUE: closes #3525/);
  assert.match(r.output, new RegExp(`applied by \`${MAINTAINER}\``));
});

test('FAIL: a PR closing an UNLABELLED issue', () => {
  const r = run(prPayload({ issues: [issue(3525, [])] }), ENFORCING);
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /UNQUEUED_WORK/);
  assert.match(r.output, new RegExp(`#3525 has no \`${READY}\` label \\(no labels\\)`));
  // The remedy has to name BOTH ways out, or the failure is a dead end.
  assert.match(r.output, new RegExp(`label one of these \`${READY}\``));
  assert.match(r.output, new RegExp(`label this PR \`${ESCAPE}\``));
});

test('FAIL: a PR closing NOTHING', () => {
  const r = run(prPayload({ issues: [] }), ENFORCING);
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /NO_LINKED_ISSUE/);
  // The #2978 lesson is IN the failure text, because a contributor reading it
  // will otherwise reach for the body edit that did not work there either.
  assert.match(r.output, /closingIssuesReferences/);
  assert.match(r.output, /#2978/);
  assert.match(r.output, /NOT from the PR body/);
});

test('PASS: a PR carrying the escape label, applied by an authority', () => {
  const r = run(prPayload({ prLabels: [[ESCAPE, MAINTAINER]], issues: [] }), ENFORCING);
  assert.equal(r.code, 0, r.output);
  assert.match(r.output, /ESCAPE_LABEL/);
  assert.match(r.output, /queue is bypassed deliberately/);
});

test("PASS: the maintainer's own PR, closing nothing and carrying no label", () => {
  const r = run(prPayload({ author: MAINTAINER, issues: [] }), ENFORCING);
  assert.equal(r.code, 0, r.output);
  assert.match(r.output, /EXEMPT_AUTHOR/);
  assert.match(r.output, /sets direction by definition/);
});

// ============================================ the escape label's own hole

test('FAIL: the escape label applied by the PR AUTHOR is not an escape', () => {
  const r = run(prPayload({ prLabels: [[ESCAPE, CONTRIBUTOR]], issues: [] }), ENFORCING);
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /SELF_APPLIED_LABEL/);
  assert.match(r.output, new RegExp(`applied by \`${CONTRIBUTOR.toLowerCase()}\``));
  assert.match(r.output, /absence of a gate/);
});

test('FAIL: a `ready` label the contributor applied to their own issue', () => {
  const r = run(prPayload({ issues: [issue(3525, [[READY, CONTRIBUTOR]])] }), ENFORCING);
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /UNQUEUED_WORK/);
  assert.match(r.output, /applied it and is not in `labelAuthorities`/);
});

test('the authority rule is a KNOB, and turning it off is what makes self-applying work', () => {
  const selfEscaped = prPayload({ prLabels: [[ESCAPE, CONTRIBUTOR]], issues: [] });
  assert.equal(run(selfEscaped, ENFORCING).code, 1);
  const off = run(selfEscaped, cfgWith({ requireLabelAuthority: false }, 'noauth'));
  assert.equal(off.code, 0, off.output);
  assert.match(off.output, /ESCAPE_LABEL/);
});

test('FAIL-CLOSED: a label present with NO event explaining it', () => {
  // `[ESCAPE, null]` is the live shape for a deleted actor, or a label applied
  // outside the timeline window. It must not read as authorised.
  const r = run(prPayload({ prLabels: [[ESCAPE, null]], issues: [] }), ENFORCING);
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /UNKNOWN_LABEL_APPLIER/);
});

test('FAIL-CLOSED: a label whose event is past the timeline page boundary', () => {
  const r = run(
    prPayload({ prLabels: [[ESCAPE, null]], issues: [], prExtra: { historyTruncated: true } }),
    ENFORCING,
  );
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /LABEL_HISTORY_TRUNCATED/);
  assert.match(r.output, /newest 100 label events/);
});

test('the NEWEST applier decides, not the oldest', () => {
  // A label removed and re-applied leaves two events. `first:100` would attribute
  // the current label to the first actor; the query asks for `last:100` and the
  // walk runs backwards, so the re-application by the maintainer is what counts.
  const payload = prPayload({ prLabels: [[ESCAPE, MAINTAINER]], issues: [] });
  payload.data.repository.pullRequest.timelineItems.nodes.unshift({
    label: { name: ESCAPE },
    actor: { login: CONTRIBUTOR },
    createdAt: '2026-08-29T09:00:00Z',
  });
  const r = run(payload, ENFORCING);
  assert.equal(r.code, 0, r.output);
  assert.match(r.output, new RegExp(`applied by \`${MAINTAINER}\``));
});

// ================================================== issue-set adjudication

test('ONE ready issue among several is enough, and the others are named', () => {
  const r = run(
    prPayload({
      issues: [issue(1, []), issue(3525, [[READY, MAINTAINER]]), issue(3, [['bug', MAINTAINER]])],
    }),
  );
  assert.equal(r.code, 0, r.output);
  assert.match(r.output, /READY_ISSUE: closes #3525/);
  assert.match(r.output, /2 other linked issue\(s\) are not queued/);
});

test('every unqueued issue is listed with ITS OWN reason, not one collapsed verdict', () => {
  const r = run(
    prPayload({
      issues: [issue(1, [['bug', MAINTAINER]]), issue(2, [[READY, CONTRIBUTOR]])],
    }),
    ENFORCING,
  );
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /#1 has no `ready` label \(it has: bug\)/);
  assert.match(r.output, /#2 carries `ready`, but `bimvoice` applied it/);
});

// ====================================================== identity spellings

test('the three dependabot spellings all resolve to the same exemption', () => {
  // Measured on PR #3333: `gh pr list` says `app/dependabot`, GraphQL says
  // `dependabot`, REST says `dependabot[bot]`. A gate that only matched one
  // would redden every dependency bump under the other two.
  for (const login of ['dependabot', 'dependabot[bot]', 'app/dependabot', 'DependaBot']) {
    const r = run(prPayload({ author: login, issues: [] }), ENFORCING);
    assert.equal(r.code, 0, `${login}: ${r.output}`);
    assert.match(r.output, /EXEMPT_AUTHOR/);
  }
});

test('normalisation is load-bearing: ONE spelling in the config covers all three', () => {
  // The test above passes without `normaliseLogin` stripping anything, because
  // the shipped config lists all three spellings verbatim. Mutating the strip
  // away left all 32 tests green — so this is the test that actually holds it.
  // A maintainer adding a bot in whichever spelling their tool printed must get
  // the same exemption under the other two.
  const oneSpelling = cfgWith({ exemptLogins: ['dependabot'] }, 'onespelling');
  for (const login of ['dependabot[bot]', 'app/dependabot']) {
    const r = run(prPayload({ author: login, issues: [] }), oneSpelling);
    assert.equal(r.code, 0, `${login}: ${r.output}`);
    assert.match(r.output, /EXEMPT_AUTHOR/);
  }
});

test('a login that merely CONTAINS an exempt one is not exempt', () => {
  const r = run(prPayload({ author: 'louistrue-bot-clone', issues: [] }), ENFORCING);
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /NO_LINKED_ISSUE/);
});

// ==================================================== fail-closed the reads

test('FAIL-CLOSED: a payload with GraphQL errors', () => {
  const r = run({ data: { repository: null }, errors: [{ message: 'Resource not accessible' }] });
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /GRAPHQL_ERRORS/);
  assert.match(r.output, /Resource not accessible/);
});

test('FAIL-CLOSED: a null pullRequest is not a PR that closes nothing', () => {
  const r = run({ data: { repository: { pullRequest: null } } });
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /NO_PULL_REQUEST/);
});

test('FAIL-CLOSED: a deleted author cannot be adjudicated', () => {
  const r = run(prPayload({ author: null, issues: [] }), ENFORCING);
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /NO_AUTHOR/);
});

test('FAIL-CLOSED: a MISSING closingIssuesReferences is not an empty one', () => {
  const payload = prPayload({ issues: [] });
  delete payload.data.repository.pullRequest.closingIssuesReferences;
  const r = run(payload, ENFORCING);
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /NO_CLOSING_ISSUES/);
});

test('FAIL-CLOSED: a truncated issue list never reports "none of them is ready"', () => {
  const r = run(prPayload({ issues: [issue(1, [])], issuesTruncated: true }), ENFORCING);
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /ISSUES_TRUNCATED/);
});

test('FAIL-CLOSED: a truncated label list on an issue', () => {
  const r = run(prPayload({ issues: [issue(1, [], { labelsTruncated: true })] }), ENFORCING);
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /LABELS_TRUNCATED/);
});

test('FAIL-CLOSED: a missing label list is not an empty one', () => {
  const payload = prPayload({ issues: [] });
  delete payload.data.repository.pullRequest.labels;
  const r = run(payload, ENFORCING);
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /NO_LABELS/);
});

test('FAIL-CLOSED: a missing label history is not "nobody applied anything"', () => {
  const payload = prPayload({ prLabels: [[ESCAPE, MAINTAINER]], issues: [] });
  delete payload.data.repository.pullRequest.timelineItems;
  const r = run(payload, ENFORCING);
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /NO_TIMELINE/);
});

// ========================================================= config refusals

test('config: a missing file is refused, not defaulted', () => {
  const r = run(prPayload({ issues: [] }), ['--config', join(TMP, 'nope.json')]);
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /NO_CONFIG/);
});

test('config: readyLabel === escapeLabel is refused', () => {
  const r = run(prPayload({ issues: [] }), cfgWith({ escapeLabel: READY }, 'collide'));
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /BAD_CONFIG/);
  assert.match(r.output, /granted\s+themselves the queue/);
});

test('config: requireLabelAuthority is NOT defaulted, because falsy would disarm it', () => {
  const patch = { ...SHIPPED };
  delete patch.requireLabelAuthority;
  const path = join(TMP, 'cfg-noknob.json');
  writeFileSync(path, JSON.stringify(patch));
  const r = run(prPayload({ issues: [] }), ['--config', path]);
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /BAD_CONFIG/);
  assert.match(r.output, /requireLabelAuthority/);
});

test('config: authority required with an EMPTY authority list is refused', () => {
  const r = run(
    prPayload({ issues: [] }),
    cfgWith({ requireLabelAuthority: true, labelAuthorities: [] }, 'noauthorities'),
  );
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /BAD_CONFIG/);
  assert.match(r.output, /not a strict gate, it is a broken one/);
});

test('config: an unknown flag is refused rather than ignored', () => {
  const r = run(prPayload({ issues: [] }), ['--stern']);
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /BAD_ARGS/);
});

// ======================================= the shipped config and the workflow

test('the SHIPPED config is the one the gate validates', () => {
  // NO `--config` HERE, DELIBERATELY, AND THAT IS THE WHOLE TEST. Every other
  // test passes ENFORCING, i.e. a temp COPY, so a shipped config its own
  // validator rejects would be invisible to all of them. This one run has to
  // read scripts/issue-queue.config.json through the gate itself.
  //
  // It briefly stopped doing that: a sweep added ENFORCING to every `run(` call
  // site including this one, which left the test passing, correctly named, and
  // no longer holding the line it was named for.
  const r = run(prPayload({ issues: [issue(3525, [[READY, MAINTAINER]])] }));
  assert.doesNotMatch(r.output, /BAD_CONFIG/, 'the shipped config must pass its own validator');
  assert.equal(r.code, 0, r.output);
  assert.equal(SHIPPED.requireLabelAuthority, true, 'ships with the self-apply rule ARMED');
  assert.ok(SHIPPED.labelAuthorities.length > 0);
  assert.ok(
    SHIPPED.mode === 'enforcing',
    `the shipped mode must be \`enforcing\`, got ${JSON.stringify(SHIPPED.mode)}. ` +
      'This was `advisory || enforcing`, which both sides of the rollout satisfy -- so ' +
      'reverting the flip failed NOTHING, and the one thing the enforcing change exists to ' +
      'set was the one thing no test held. A bad merge resolution could have undone it ' +
      'silently. If this failed and no rollback was intended, restore `"mode": "enforcing"` ' +
      'in scripts/issue-queue.config.json -- the flip was undone by accident, most likely a ' +
      'merge resolution. If the gate is ever deliberately returned to advisory, change this ' +
      'assertion in the same commit, so the rollback is a decision someone made rather ' +
      'than a diff nobody noticed.',
  );
});

test('the workflow has NO `paths:` filter, and that is asserted rather than intended', () => {
  // The same claim pr-review-signal.yml makes and the same reason: #3305's gate
  // could not fire on the file it guarded, because that file was in no path
  // filter. A steering gate is worse — the config naming who may steer lives
  // under scripts/, so a path filter would let the PR that edits it dodge the
  // job that runs it.
  const text = readFileSync(WORKFLOW, 'utf8');
  assert.doesNotMatch(text, /^\s*paths(-ignore)?:/m, 'issue-queue.yml must have no paths filter');
  assert.doesNotMatch(text, /^\s*branches(-ignore)?:/m, 'and no branches filter, for the same reason');
});

test('the workflow re-evaluates on edit and on (un)labelling', () => {
  // `edited` fires on a retarget AND on a body edit that adds `Closes #N`;
  // `labeled`/`unlabeled` are the events that change this gate's answer without
  // changing a single line of code. GitHub's DEFAULT type list is
  // opened/synchronize/reopened and carries none of the three.
  const text = readFileSync(WORKFLOW, 'utf8');
  const types = /types:\s*\[([^\]]*)\]/.exec(text);
  assert.ok(types, 'issue-queue.yml must name its pull_request types explicitly');
  const named = types[1].split(',').map((s) => s.trim());
  for (const t of ['opened', 'synchronize', 'reopened', 'edited', 'labeled', 'unlabeled']) {
    assert.ok(named.includes(t), `missing pull_request type \`${t}\` (found: ${named.join(', ')})`);
  }
});

test('the workflow runs THIS harness, so the gate is not the only thing checked', () => {
  const text = readFileSync(WORKFLOW, 'utf8');
  assert.match(text, /node --test scripts\/check-issue-queue\.test\.mjs/);
  assert.match(text, /node scripts\/check-issue-queue\.mjs/);
});
