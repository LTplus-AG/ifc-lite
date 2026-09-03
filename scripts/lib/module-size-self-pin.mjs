/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one place `scripts/check-module-size.mjs` is measured BY a run that also
 * rewrites it: where its pin lives, what the pin looks like, and how to plan an
 * update whose own row survives the rewrite.
 *
 * The gate pins its allowlist digests in its own source (see ALLOWLIST_DIGESTS
 * there for why the pin cannot live beside the rows it guards), and that source
 * is itself a measured `.mjs` module under `scripts/`. So `--update` closes a
 * loop: the rows it writes determine the digest block, the block's line count
 * determines the file's size, and the file's size determines its own row.
 *
 * `--update` used to walk that loop exactly once, in the wrong order: it
 * measured the tree, wrote the row for `scripts/check-module-size.mjs`, and
 * only THEN rewrote the block. A sweep that changes the SCOPE COUNT moves the
 * block's line count, so the row it had already written described a file that
 * no longer existed — and the post-write self-check re-used the same stale
 * measurement, so the command reported success and exited 0 on a baseline it
 * had just broken. The next plain run measured the file for real and failed:
 * green locally, red in CI, no local reproduction, on the one gate whose whole
 * job is to stop that (#3727, #3693).
 *
 * `settleUpdate` walks the loop to a FIXED POINT instead, and does it entirely
 * in memory so that a refusal (`--update` declining to raise a budget) still
 * leaves the tree byte-for-byte untouched.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { allowlistDigests, countLines, planUpdate } from './module-size-ratchet.mjs';

/**
 * The pinned file, as the walk spells it. The walk normalises separators
 * (`relative(root, p).split('\\').join('/')`), and this is what that produces
 * for the gate's own source, so `settleUpdate` can match its row by equality.
 * Deriving it a second time at the call site is what would let the two drift.
 */
export const SELF_REL = 'scripts/check-module-size.mjs';

/**
 * The ALLOWLIST_DIGESTS block in `scripts/check-module-size.mjs`, matched from
 * its `const` line to the first line that is exactly `};`. Non-greedy on
 * purpose: the block is the FIRST such object in the file.
 */
export const PIN_RE = /^const ALLOWLIST_DIGESTS = \{[\s\S]*?^\};$/m;

/** The block as it is written back: one reviewable line per scope (#3291). */
export function renderPinBlock(digests) {
  const rows = [...digests].map(([scope, digest]) => `  '${scope}': '${digest}',`);
  return `const ALLOWLIST_DIGESTS = {\n${rows.join('\n')}\n};`;
}

/**
 * `{ path, text }` for the pinned file under `root`, with `text` null when
 * there is no pin to move. That is the synthetic tree the test harness builds
 * under `--root`: a documented case, not an error, and the caller prints the
 * digests instead of writing them.
 */
export function readSelfPin(root) {
  const path = join(root, SELF_REL);
  try {
    const text = readFileSync(path, 'utf8');
    if (PIN_RE.test(text)) return { path, text };
  } catch {
    // No file under this root, which reads the same as no pin in it.
  }
  return { path, text: null };
}

/**
 * `text` with its pin block replaced by `digests`.
 *
 * A replacer FUNCTION, not a string: `$&` and friends are substitution patterns
 * in a string replacement, so a scope containing `$&` would splice the matched
 * block back into itself. Needs a directory named with `$&`, so it is unlikely
 * rather than impossible -- and free to rule out.
 */
export function repin(text, digests, render = renderPinBlock) {
  return text.replace(PIN_RE, () => render(digests));
}

/**
 * Bound on the fixed-point iteration. An unbounded loop over a self-referential
 * file is a HANG, which is the one failure mode nothing reports — worse than
 * the wrong answer it would be replacing.
 *
 * With `renderPinBlock` the map is `lines -> L1 if lines > LIMIT else L0`,
 * where L1 and L0 differ by the single line the self row's scope adds, so it
 * has a fixed point two passes in and this bound is unreachable today. It is a
 * backstop against a future renderer whose block length depends on something
 * else, and `render` is injectable so a test can BE that renderer — a bound
 * nothing can reach is a bound nobody has checked.
 */
export const MAX_SETTLE_PASSES = 8;

/**
 * Plan the allowlist rewrite against the file the rewrite will PRODUCE, not the
 * one on disk when the run started. `self` is what `readSelfPin` returned.
 *
 * Two things move between passes, and both are the point:
 *  - the self file's measured line count, so the row records the post-rewrite
 *    size rather than the pre-rewrite one;
 *  - the SCOPE, when that count actually moves. A scoped `--update` re-records
 *    only the files the change touched (#3398), and a run whose own write grows
 *    that file has touched it — leaving it out is what stranded the row over its
 *    budget with no scoped rerun able to reach it. Nothing else is annexed: the
 *    self path joins the scope only on a pass where the projection disagrees
 *    with the measurement.
 *
 * Returns `{ plan, digests, selfText, files, passes }`, where `files` is the
 * measurement the plan settled on. That is what the tree WILL hold once the
 * caller writes `selfText`, so it — not the measurement the run started from —
 * is what the post-write check must evaluate. THROWS if it does not settle,
 * because the caller has written nothing yet and "could not decide" must not
 * reach the tree as a half-applied sweep.
 */
export function settleUpdate({ files, allowlist, changed, self, render = renderPinBlock }) {
  let nextFiles = files;
  let nextChanged = changed;
  let drift = '';
  for (let passes = 1; passes <= MAX_SETTLE_PASSES; passes += 1) {
    const plan = planUpdate(nextFiles, allowlist, nextChanged);
    const digests = allowlistDigests(plan.next);
    const selfText = self.text === null ? null : repin(self.text, digests, render);
    const measured = nextFiles.find((f) => f.rel === SELF_REL);
    const lines = selfText === null ? null : countLines(selfText);
    if (lines === null || measured === undefined || measured.lines === lines) {
      return { plan, digests, selfText, files: nextFiles, passes };
    }
    drift = `${measured.lines} -> ${lines}`;
    nextFiles = nextFiles.map((f) => (f.rel === SELF_REL ? { ...f, lines } : f));
    nextChanged = nextChanged === null ? null : new Set([...nextChanged, SELF_REL]);
  }
  throw new Error(
    `${SELF_REL} never settled: rewriting its digest block keeps changing its own line count ` +
      `(last ${drift}) after ${MAX_SETTLE_PASSES} passes, so any row written for it would already ` +
      `be stale. This is a defect in the gate, not in your change.`,
  );
}
