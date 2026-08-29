/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Pure classification for `scripts/scan-dirty-prs.mjs` (issue #3443).
 *
 * MEASURED, NOT SPECULATED: a PR whose `mergeable` reads `CONFLICTING` runs no
 * `pull_request` CI at all -- not "may run late", not "runs a reduced set" --
 * absent, with no red check and no message. Pushing a new commit to it does not
 * clear this; only resolving the conflict does. Live on #3389 the night of
 * 2026-08-27/28: `gh pr checks` showed 6 rows (Vercel + CodeRabbit only) while
 * `mergeable: CONFLICTING` held, and an empty commit polled for five minutes
 * left `total_count: 2` unchanged. Full writeup in issue #3443.
 *
 * THE CONSTRAINT THAT SHAPES THIS FILE: if GitHub does not fire `pull_request`
 * for a conflicted PR, nothing triggered BY `pull_request` can ever report on
 * one -- that includes `.github/workflows/pr-review-signal.yml`, which exists
 * for exactly this shape of absence (#3312) and is blind to this one. There is
 * no in-PR fix. What CAN observe it is a job on its own trigger --
 * `schedule`/`workflow_dispatch` -- that asks the API which open PRs are
 * conflicted, independent of any single PR's ability to fire anything.
 *
 * `CONFLICTING` IS DISTINGUISHED FROM `UNKNOWN`. GitHub computes mergeability
 * lazily and a fresh PR briefly reads `UNKNOWN` before settling -- that is not
 * evidence of anything and is reported separately, advisory only, never as a
 * silent-CI finding.
 *
 * REQUIRED LANES ARE DERIVED FROM `test.yml`, THE SAME WAY #3312's GATE DOES
 * IT, on purpose: a PR that went dirty AFTER its lanes already ran (measured on
 * #3417: `mergeable: CONFLICTING` with all 15 required lanes present in the
 * rollup, because they ran while it was still clean) is not this defect. Row
 * count alone cannot tell the two apart -- #3417 carried 40 rows, #3411 carried
 * 19 -- so this compares NAMES against the workflow's own required set rather
 * than a floor. #3411, live, was missing every one of the 15.
 */

/** Thrown for every fail-closed condition; `reason` is the machine-readable tag. */
export class DirtyPrScanError extends Error {
  /**
   * @param {string} reason
   * @param {string} message
   */
  constructor(reason, message) {
    super(message);
    this.name = 'DirtyPrScanError';
    this.reason = reason;
  }
}

/**
 * Required lane names absent from a PR's status-check rollup.
 *
 * @param {string[]} required
 * @param {Array<{ name?: string, context?: string }>} rollup
 * @returns {string[]}
 */
export function missingLanes(required, rollup) {
  const present = new Set((Array.isArray(rollup) ? rollup : []).map((c) => c.name ?? c.context ?? ''));
  return required.filter((n) => !present.has(n)).sort();
}

/**
 * One open PR's silence verdict.
 *
 * `silent` is true only when BOTH hold: the PR reads as conflicted
 * (`mergeable: CONFLICTING`, or `mergeStateStatus: DIRTY` -- GitHub has shown
 * both spellings live), AND at least one lane that `test.yml` requires is
 * absent from its rollup. Either alone is not enough: `CONFLICTING` with a
 * full rollup (#3417) means the lanes ran before the PR went dirty, and a
 * missing lane with `mergeable: MERGEABLE` is a different, ordinary problem
 * (a lane still queued, a path filter, a real failure) that this gate is not
 * built to explain.
 *
 * @param {{ number: number, title?: string, url?: string, mergeable?: string,
 *   mergeStateStatus?: string, isDraft?: boolean,
 *   statusCheckRollup?: Array<{ name?: string, context?: string }> }} pr
 * @param {string[]} required
 */
export function classifyPr(pr, required) {
  if (typeof pr?.number !== 'number') {
    throw new DirtyPrScanError('BAD_PR', `A PR object is missing a numeric \`number\`: ${JSON.stringify(pr)}`);
  }
  if (!Array.isArray(required) || required.length === 0) {
    throw new DirtyPrScanError(
      'EMPTY_REQUIRED_SET',
      'The required lane set is empty. A presence check against an empty set passes over every ' +
        'possible rollup, which is the vacuity this gate exists to reject.',
    );
  }

  const rollup = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : [];
  const missing = missingLanes(required, rollup);
  const isConflicted = pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY';
  const isUnknown = pr.mergeable === 'UNKNOWN' || pr.mergeStateStatus === 'UNKNOWN';

  return {
    number: pr.number,
    title: typeof pr.title === 'string' ? pr.title : '',
    url: typeof pr.url === 'string' ? pr.url : '',
    mergeable: pr.mergeable ?? null,
    mergeStateStatus: pr.mergeStateStatus ?? null,
    isDraft: pr.isDraft === true,
    rollupCount: rollup.length,
    missing,
    // A conflicted PR with every required lane present already ran them
    // before going dirty (#3417) -- not this defect.
    silent: isConflicted && missing.length > 0,
    // Advisory only -- see the docblock. Never folds into `silent`.
    unknownAdvisory: isUnknown && missing.length > 0,
  };
}

/**
 * Classify every open PR in `prs` against `required`.
 *
 * @param {unknown} prs
 * @param {string[]} required
 */
export function scanPrs(prs, required) {
  if (!Array.isArray(prs)) {
    throw new DirtyPrScanError(
      'BAD_INPUT',
      `Expected an array of open PRs from \`gh pr list\`; got ${typeof prs}. An unreadable list ` +
        'must never be read as "no open PRs".',
    );
  }
  return prs.map((pr) => classifyPr(pr, required));
}

/**
 * Render a scan into a verdict and human-readable lines.
 *
 * @param {ReturnType<typeof scanPrs>} results
 * @param {string[]} required
 */
export function report(results, required) {
  const silent = results.filter((r) => r.silent);
  const unknownAdvisory = results.filter((r) => r.unknownAdvisory);
  const lines = [];

  lines.push(
    `Scanned ${results.length} open PR(s) against ${required.length} required lane(s) ` +
      `derived from .github/workflows/test.yml.`,
  );

  if (silent.length === 0) {
    lines.push(
      '✅ No open PR is CONFLICTING/DIRTY with a required lane missing -- this scan cannot see ' +
        'a lane that has not run yet, only one whose absence has already been reported.',
    );
  } else {
    lines.push(
      `❌ ${silent.length} open PR(s) are conflicted and have NOT run \`pull_request\` CI on ` +
        'their current head. Pushing a new commit will not fix this -- only resolving the ' +
        'conflict (merge/rebase from the base branch) restores CI.',
    );
    for (const r of silent) {
      lines.push(
        `   #${r.number}${r.title ? ` ${r.title}` : ''}${r.url ? ` -- ${r.url}` : ''}`,
        `     mergeable=${r.mergeable} mergeStateStatus=${r.mergeStateStatus} ` +
          `rollup=${r.rollupCount} row(s); missing ${r.missing.length}/${required.length} ` +
          `required lane(s): ${r.missing.join(', ')}`,
      );
    }
  }

  if (unknownAdvisory.length > 0) {
    lines.push(
      `⚠️  ${unknownAdvisory.length} open PR(s) read \`mergeable: UNKNOWN\` with required lanes ` +
        'missing -- GitHub has not finished computing mergeability. This is advisory only: it ' +
        're-checks itself, so it is reported but does not fail this job.',
    );
    for (const r of unknownAdvisory) {
      lines.push(`   #${r.number}${r.title ? ` ${r.title}` : ''}${r.url ? ` -- ${r.url}` : ''}`);
    }
  }

  return { ok: silent.length === 0, lines };
}
