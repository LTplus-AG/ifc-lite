#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression harness for scripts/check-swallowed-push.mjs.
 *
 * The gate reports "no swallowed pushes". That sentence is equally true of a
 * clean tree and of a scan that examined nothing, so every way it could go
 * false-green is an executable case here: the workflow directory missing, the
 * directory present but empty, and each spelling of a discarded exit status.
 *
 * Method matches scripts/check-clash-degenerate-reason-parity.test.mjs: write a
 * mutated tree to a temp dir, run the UNMODIFIED checker against it via
 * `--root`, and assert exit code plus message.
 *
 * Run: node --test scripts/check-swallowed-push.test.mjs
 * (wired as a step of the CI node-test job in .github/workflows/test.yml).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSwallowedPushes, SWALLOWED_PUSH, HANDLED_PUSH, MARKER } from './check-swallowed-push.mjs';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const CHECKER = join(SCRIPTS, 'check-swallowed-push.mjs');

/** Writes `files` (relative path -> content) into a temp tree and runs the gate. */
function runOn(files) {
  const dir = mkdtempSync(join(tmpdir(), 'swallowed-push-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    const r = spawnSync(process.execPath, [CHECKER, '--root', dir], { encoding: 'utf8' });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CLEAN = `name: x
jobs:
  release:
    steps:
      - run: |
          git tag "v1" || true
          git push origin "v1"
`;

test('a clean workflow passes, and says how much it looked at', () => {
  const { status, out } = runOn({ '.github/workflows/release.yml': CLEAN });
  assert.equal(status, 0, out);
  assert.match(out, /check-swallowed-push: OK \(1 workflow files/);
});

test('`|| true` on a push is caught', () => {
  const { status, out } = runOn({
    '.github/workflows/release.yml': CLEAN.replace('git push origin "v1"', 'git push origin "v1" || true'),
  });
  assert.equal(status, 1, out);
  assert.match(out, /release\.yml:\d+.*git push origin "v1" \|\| true/);
});

test('`|| :` is caught too — a shell no-op reads as decorative', () => {
  const { status, out } = runOn({
    '.github/workflows/release.yml': CLEAN.replace('git push origin "v1"', 'git push origin "v1" || :'),
  });
  assert.equal(status, 1, out);
});

test('`|| true` on `git tag` is NOT caught — idempotency there is the point', () => {
  // The whole value of this gate is that it separates the two. A rule that
  // flagged both would be suppressed wholesale on its first run.
  const { status } = runOn({ '.github/workflows/release.yml': CLEAN });
  assert.equal(status, 0);
  assert.ok(SWALLOWED_PUSH.test('git push origin "v1" || true'));
  assert.ok(!SWALLOWED_PUSH.test('git tag "v1" || true'));
});

test('a no-op followed by a command-list delimiter is still swallowed', () => {
  // End-of-line was not the only spelling. Chaining after the no-op discards the
  // push status just as thoroughly, and an `(?:$|#)` anchor walks past it.
  // Reported by CodeRabbit on #3208; each of these was verified to flip the
  // regex from false to true.
  const forms = {
    'semicolon': 'git push origin "v1" || true; echo continuing',
    'background': 'git push origin "v1" || true & ',
    'subshell close': '(git push origin "v1" || true)',
    'pipe': 'git push origin "v1" || true | tee log',
  };
  for (const [label, line] of Object.entries(forms)) {
    const { status, out } = runOn({
      '.github/workflows/release.yml': CLEAN.replace('          git push origin "v1"', `          ${line}`),
    });
    assert.equal(status, 1, `${label} was not caught:\n${out}`);
  }
});

test('a marked site is excused AND named, not hidden', () => {
  const marked = CLEAN.replace(
    '          git push origin "v1"',
    `          # ${MARKER}: mirror remote is best-effort\n          git push origin "v1" || true`,
  );
  const { status, out } = runOn({ '.github/workflows/release.yml': marked });
  assert.equal(status, 0, out);
  assert.match(out, /1 marked/);
  assert.match(out, /marked: .*release\.yml/);
});

test('a MISSING workflow directory fails instead of reporting clean', () => {
  // The failure this gate exists to prevent, one level up: a scan that examined
  // nothing must not be indistinguishable from a scan that found nothing.
  const { status, out } = runOn({ 'README.md': 'no workflows here\n' });
  assert.equal(status, 1, out);
  assert.match(out, /scan root has moved|examined nothing/);
});

test('an EMPTY workflow directory fails instead of reporting clean', () => {
  const { status, out } = runOn({ '.github/workflows/.keep': '' });
  assert.equal(status, 1, out);
  assert.match(out, /No workflow files found/);
});

test('the detector reports the right line number', () => {
  // An offender named at the wrong line sends the reader to innocent code.
  const src = ['a', 'b', 'git push origin "x" || true', 'c'].join('\n');
  const { hits } = findSwallowedPushes(src);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 3);
});

// ---------------------------------------------------------------------------
// #3212: the rule must see what the SHELL sees, not what one physical line does.

test('a swallow split across a backslash continuation is caught', () => {
  // Neither physical line matches on its own — this is the whole point.
  // `${…}` is written as a concatenation so the source carries no template
  // placeholder inside a plain string (oxlint no-template-curly-in-string); the
  // fixture text is identical to the release workflow's.
  const VER = '"v$' + '{VERSION}"';
  const pushLine = `          git push origin ${VER} \\`;
  const src = ['      - run: |', pushLine, '            || true'].join('\n');
  assert.equal(SWALLOWED_PUSH.test(pushLine), false,
    'guard: the first physical line must NOT match, or this test proves nothing');
  assert.equal(SWALLOWED_PUSH.test('            || true'), false,
    'guard: the second physical line must NOT match either');

  const { hits } = findSwallowedPushes(src);
  assert.equal(hits.length, 1, 'the continuation was not folded into one logical command');
  assert.equal(hits[0].line, 2, 'the report must point at the line the push is ON');
  assert.equal(hits[0].kind, 'no-op');
});

test('an escaped backslash does NOT continue the line', () => {
  // TWO trailing backslashes: `\\` is one escaped backslash, so the command
  // ENDS here and `|| true` on the next line belongs to nothing.
  //
  // The first version of this test used `echo "a\\\\"` — whose last character
  // is a quote, not a backslash — and contained no `git push` on either line,
  // so `hits.length === 0` held for every possible fold rule. It survived a
  // mutation replacing the parity rule with "any trailing backslash continues".
  // This version does not: under that mutation the two lines join and the push
  // is reported.
  const first = '          git push origin a\\\\';
  assert.ok(first.endsWith('\\\\'), 'guard: the fixture must really end in two backslashes');
  assert.ok(first.includes('git push'), 'guard: the fixture must contain a push to be foldable');

  const { hits } = findSwallowedPushes([first, '          || true'].join('\n'));
  assert.equal(hits.length, 0, 'joined across an EVEN number of trailing backslashes');
});

test('an ODD number of trailing backslashes DOES continue the line', () => {
  // The other direction, so the parity rule is pinned rather than just its
  // false branch. Three backslashes = one escaped pair plus a continuation.
  const { hits } = findSwallowedPushes(
    ['          git push origin a\\\\\\', '          || true'].join('\n'),
  );
  assert.equal(hits.length, 1, 'an odd count must continue the command');
});

test('the `|| |` and `|| &` guards keep those shapes unflagged', () => {
  // Pins the `(?![|&])`-equivalent behaviour of the handler alternation. These
  // are shell syntax errors, and flagging them would be noise on broken code
  // rather than a swallow.
  for (const line of ['git push x || | true', 'git push x || & true']) {
    const { hits } = findSwallowedPushes(line);
    assert.equal(hits.length, 0, `flagged a shell syntax error: ${line}`);
  }
});

test('a marker does not reach a neighbouring push in the same folded group', () => {
  // The regression the fold introduces: one logical line spans several physical
  // ones, so a `joined.includes(MARKER)` would let a marker written for the
  // mirror push silently exempt the origin push chained after it — and that
  // push would vanish from the report entirely, not merely be listed as marked.
  const src = [
    '          # allow-swallowed-push: mirror is best-effort',
    '          git push mirror "$TAG" || true; \\',
    '          git push origin "$TAG" || true',
  ].join('\n');
  const { hits, marked } = findSwallowedPushes(src);
  assert.equal(marked.length, 1, 'the marked mirror push must still be named');
  assert.equal(hits.length, 1, 'the UNMARKED origin push must still be reported');
});

test('`|| echo` is a swallow too, and is reported as [handled]', () => {
  const src = '          git push origin "$TAG" || echo "push failed, continuing"';
  const { hits } = findSwallowedPushes(src);
  assert.equal(hits.length, 1, 'a push whose failure is handled by any command is still swallowed');
  assert.equal(hits[0].kind, 'handled', 'must be distinguishable from `|| true` in the report');
});

test('`git push ; true` is NOT flagged — set -e fires before `true` runs', () => {
  // Checked rather than assumed: the status is not discarded here, so flagging
  // it would be a false positive on correct code.
  const { hits } = findSwallowedPushes('          git push origin "$TAG" ; true');
  assert.equal(hits.length, 0, 'a semicolon does not discard the push status under set -e');
});

test('`||` on something that is not a push stays unflagged', () => {
  const { hits } = findSwallowedPushes('          git tag -a "$TAG" -m msg || true');
  assert.equal(hits.length, 0, '`|| true` on `git tag` is correct and must stay unflagged');
});

test('the marker still exempts a continuation-split push, and names it', () => {
  const src = [
    '          # allow-swallowed-push: mirror remote is best-effort',
    '          git push mirror "$TAG" \\',
    '            || true',
  ].join('\n');
  const { hits, marked } = findSwallowedPushes(src);
  assert.equal(hits.length, 0, 'the marker above the FIRST physical line must still apply');
  assert.equal(marked.length, 1, 'a marked site must stay named, not vanish');
});

test('handled_push_is_a_superset: HANDLED_PUSH matches everything SWALLOWED_PUSH does', () => {
  // `findSwallowedPushes` uses HANDLED_PUSH as the GATE and SWALLOWED_PUSH only
  // to label the hit. That is only sound while this holds. If someone tightens
  // HANDLED_PUSH and breaks it, every `|| true` site stops being reported —
  // silently, with the gate still exiting 0. An absence that reads as success,
  // which is the exact failure this gate exists to prevent, reintroduced into
  // the gate itself.
  const heads = ['git push', 'git  push', '  git push origin main', 'run: git push "$T"'];
  const tails = ['|| true', '||true', '|| :', '||  true # note', '|| true; echo x', '|| true)'];
  let matched = 0;
  for (const h of heads) {
    for (const t of tails) {
      const line = `${h} ${t}`;
      if (!SWALLOWED_PUSH.test(line)) continue;
      matched += 1;
      assert.ok(
        HANDLED_PUSH.test(line),
        `SWALLOWED_PUSH matches but HANDLED_PUSH does not, so this site would go ` +
          `UNREPORTED by findSwallowedPushes: ${JSON.stringify(line)}`,
      );
    }
  }
  // Non-vacuity: the loop must actually have exercised the relation, or it
  // passes by testing nothing.
  assert.ok(matched >= 20, `only ${matched} SWALLOWED_PUSH matches were generated`);
});

test('a comment ending in a backslash cannot smuggle a push into command position', () => {
  // In shell a `#` comment runs to end of line and a trailing backslash inside
  // it does NOT continue the command, so the push below is commented out. The
  // fold does join them (it is not a shell parser), and the COMMAND-POSITION
  // anchor is what stops that becoming a false positive: after the join the
  // push is preceded by comment text, not by a separator.
  //
  // This is also why the marker cannot reach a neighbouring push: a marker is a
  // comment, and a comment ends the logical command, so there is no valid shell
  // in which one folded group carries a marker and a later live push.
  const src = [
    '          echo hi  # allow-swallowed-push: not really \\',
    '          git push origin "$TAG" || true',
  ].join('\n');
  const { hits, marked } = findSwallowedPushes(src);
  assert.equal(hits.length, 0, 'a commented-out push must not be reported');
  assert.equal(marked.length, 0, 'nor silently counted as an exemption');
});

// ---------------------------------------------------------------------------
// Command position, both directions. Review found the first version of the
// anchor MISSED four genuine shapes — and for a release-safety gate a miss is
// far worse than a false positive: it defeats the gate silently, while a false
// positive is visible and has the marker as an escape hatch.

const PUSH = 'git' + ' push';

test('a swallowed push is caught in every genuine command position', () => {
  const cases = [
    [`          ${PUSH} origin "$T" || true`, 'plain'],
    [`          { ${PUSH} origin "$T" || true; }`, 'brace group'],
    [`          if ${PUSH} origin "$T" || true; then echo x; fi`, 'if condition'],
    [`          ! ${PUSH} origin "$T" || true`, 'negation'],
    [`          FOO=1 ${PUSH} origin "$T" || true`, 'env assignment'],
    [`          cmd; ${PUSH} origin "$T" || true`, 'after a separator'],
    [`      - run: ${PUSH} origin "$T" || true`, 'inline run:'],
  ];
  for (const [line, what] of cases) {
    const { hits } = findSwallowedPushes(line);
    assert.equal(hits.length, 1, `missed a swallowed push in ${what}: ${line}`);
  }
});

test('a push that fails LOUDLY is not flagged, whatever follows it', () => {
  // `|| exit 1` is the idiom this gate's own message tells you to switch to.
  // Flagging it makes the gate contradict its remedy.
  const cases = [
    `          ${PUSH} origin "$T" || exit 1`,
    `          ${PUSH} origin "$T" || { echo a; exit 1; }`,
    `          ${PUSH} origin "$T" || return 1`,
    `          ${PUSH} origin "$T" || false`,
    // The handler must be THIS push's: an unscoped match ran past `exit 1` and
    // adopted the independent `cleanup` command's `echo`.
    `          ${PUSH} origin "$T" || exit 1; cleanup || echo cleanup-failed`,
  ];
  for (const line of cases) {
    const { hits } = findSwallowedPushes(line);
    assert.equal(hits.length, 0, `flagged a correctly-handled push: ${line}`);
  }
});

test('a push in ARGUMENT position is not a command and is not flagged', () => {
  // The false positive the command-position anchor exists for: after folding,
  // `echo` consumes the rest and nothing is pushed.
  const { hits } = findSwallowedPushes(`          echo "hello" ${PUSH} origin v2 || true`);
  assert.equal(hits.length, 0, 'flagged a push that is an argument to echo');
});

test('a redirection does not hide a swallowed push', () => {
  // `2>&1` contains `&`, and a first version of OWN_ARGS excluded `&` as a
  // separator — so the most ordinary shape in a workflow stopped matching and
  // the gate reported clean. Same fail-open direction as the command-position
  // anchor: a character class cannot tell a redirection from a separator, so
  // the arg run stops only at `;` and at the `||` itself.
  const cases = [
    `          ${PUSH} origin main 2>&1 || true`,
    `          ${PUSH} origin main >/dev/null 2>&1 || true`,
    `          ${PUSH} origin "a|b" || true`,
  ];
  for (const line of cases) {
    const { hits } = findSwallowedPushes(line);
    assert.equal(hits.length, 1, `a redirection or quoted pipe hid a swallow: ${line}`);
  }
});

test('the handler must still be the push’s own, across a semicolon', () => {
  // The other direction of the same rule: widening OWN_ARGS must not re-open
  // the case it was introduced for.
  const { hits } = findSwallowedPushes(
    `          ${PUSH} origin "$T" || exit 1; cleanup || echo cleanup-failed`,
  );
  assert.equal(hits.length, 0, 'adopted a later command’s handler again');
});
