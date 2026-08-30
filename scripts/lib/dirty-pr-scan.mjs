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
 *
 * MISSING LANES HAVE TWO CAUSES, NOT ONE. `test.yml` opens with
 * `on: pull_request: branches: [main]`, so a PR stacked on a feature branch is
 * silent for a reason a merge has no power over. #3411 is that shape -- its
 * base is `fix-3353-snap-f32-invisible-floor` -- so the flagship fixture above
 * is BOTH conflicted and base-filtered, and either cause reported alone hands
 * it a remedy that provably does not restore a lane -- neither retargeting a
 * dirty PR nor merging into a feature-based one fires `pull_request`.
 * `classifyPr` reads `baseRefName`, names the cause a merge cannot clear, and
 * flags the both-case so the report carries both remedies; see its docblock.
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
 * The base branches `test.yml` will fire `pull_request` for.
 *
 * WHY THIS EXISTS: a missing lane has TWO causes, not one, and they need
 * opposite remedies. `.github/workflows/test.yml` opens with
 * `on: pull_request: branches: [main]`, so a stacked PR based on a feature
 * branch never fires it -- measured on #3411 (base
 * `fix-3353-snap-f32-invisible-floor`) and #3405 (base
 * `fix-3338-isolate-expansion-gate`), both reading MERGEABLE/CLEAN with 0 of
 * the 15 required lanes present. Telling such a PR to resolve a merge conflict
 * is advice that provably cannot work: the base filter still blocks the
 * workflow afterwards. This is #3429's first case; the conflicted PR is its
 * second.
 *
 * Parsed from the workflow text rather than hardcoded, for the same reason the
 * lane names are: a constant here would silently diverge the day the filter
 * changes, and the failure mode of a diverged constant is a wrong remedy, not
 * a loud error.
 *
 * @param {string} text - `.github/workflows/test.yml` contents.
 * @returns {string[] | null} the allowed base branches, or `null` when
 *   `pull_request` carries no `branches:` filter at all (every base fires).
 */
export function pullRequestBaseBranches(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new DirtyPrScanError('NO_WORKFLOW_TEXT', 'The workflow text is empty, so its `pull_request` base filter cannot be read.');
  }
  const lines = text.split(/\r?\n/);

  let i = lines.findIndex((l) => /^on:\s*(#.*)?$/.test(l));
  if (i === -1) {
    throw new DirtyPrScanError('NO_ON_BLOCK', 'The workflow has no top-level `on:` block, so its triggers cannot be read.');
  }

  // Walk the `on:` block for `pull_request:`; a line starting in column 0 ends it.
  let prIndent = -1;
  for (i += 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() !== '' && /^\S/.test(line)) break;
    const m = /^(\s+)pull_request:\s*(#.*)?$/.exec(line);
    if (m) {
      prIndent = m[1].length;
      break;
    }
  }
  if (prIndent === -1) {
    throw new DirtyPrScanError(
      'NO_PULL_REQUEST_TRIGGER',
      'The workflow has no `pull_request:` trigger. This gate exists to explain why a ' +
        '`pull_request` lane is absent; against a workflow that has no such trigger the ' +
        'question is meaningless, and answering it anyway would be a guess.',
    );
  }

  // Walk `pull_request:`'s own body for `branches:`; anything at or left of its
  // indent ends it (that is `push:`, whose own `branches: [main]` must not be read here).
  for (i += 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    const indent = line.length - line.trimStart().length;
    if (indent <= prIndent) return null; // `pull_request:` had no `branches:` filter.

    const flow = /^\s*branches:\s*\[([^\]]*)\]\s*(#.*)?$/.exec(line);
    if (flow) return finishBranches(splitFlowList(flow[1]));

    if (/^\s*branches:\s*(#.*)?$/.test(line)) {
      const items = [];
      for (i += 1; i < lines.length; i += 1) {
        const item = /^\s*-\s*(.+?)\s*$/.exec(lines[i]);
        if (!item) break;
        items.push(stripQuotes(item[1]));
      }
      return finishBranches(items);
    }
  }
  return null;
}

/** @param {string} raw */
function splitFlowList(raw) {
  return raw
    .split(',')
    .map((v) => stripQuotes(v.trim()))
    .filter((v) => v !== '');
}

/** @param {string} v */
function stripQuotes(v) {
  return v.replace(/^['"]|['"]$/g, '');
}

/** @param {string[]} branches */
function finishBranches(branches) {
  if (branches.length === 0) {
    throw new DirtyPrScanError(
      'EMPTY_BASE_BRANCHES',
      'The workflow declares a `pull_request` `branches:` filter with no entries. Every PR ' +
        'would read as base-filtered, which is a wrong verdict rather than a missing one.',
    );
  }
  for (const b of branches) {
    if (/[*?[\]!+]/.test(b)) {
      throw new DirtyPrScanError(
        'UNSUPPORTED_BRANCH_PATTERN',
        `The \`pull_request\` \`branches:\` filter contains the glob \`${b}\`, which this gate ` +
          'does not evaluate. Matching it wrongly would hand a PR a remedy that cannot work; ' +
          'teach this function the pattern syntax instead of guessing.',
      );
    }
  }
  return branches;
}

/**
 * One open PR's silence verdict, and WHICH of the two causes produced it.
 *
 * A required lane can be absent for two independent reasons, and they take
 * opposite remedies -- getting the split right is most of this gate's value:
 *
 * - `BASE_FILTERED`: the PR's base is not a branch `test.yml` fires
 *   `pull_request` for (`branches: [main]`). Measured on #3411 and #3405, both
 *   stacked on a feature branch with 0 of 15 lanes. Resolving a merge conflict
 *   does nothing here; the PR has to be retargeted (or its base landed first).
 *   This is #3429's first case, and it is checked FIRST because it is the cause
 *   a merge has no power over, so it is the one that names the group.
 *
 *   IT IS NOT THE WHOLE REMEDY WHEN A PR IS BOTH (#3411 live is that shape):
 *   retargeting a dirty PR at `main` clears the filter and leaves the conflict,
 *   which fires nothing on its own, so the retarget line alone buys zero lanes.
 *   Such a PR carries `alsoConflicted` and the report names BOTH remedies.
 * - `CONFLICTED`: the base IS one `test.yml` fires for, but the PR reads
 *   conflicted (`mergeable: CONFLICTING`, or `mergeStateStatus: DIRTY` --
 *   GitHub has shown both spellings live), so GitHub computes no merge ref and
 *   fires nothing. Resolving the conflict is what restores CI. This is #3443,
 *   and #3429's second case.
 *
 * In both, at least one required lane must actually be missing. A conflicted
 * PR with a full rollup (#3417) ran its lanes before going dirty; a missing
 * lane on a clean, `main`-based PR is an ordinary problem (still queued, a
 * path filter, a real failure) this gate is not built to explain.
 *
 * @param {{ number: number, title?: string, url?: string, baseRefName?: string,
 *   mergeable?: string, mergeStateStatus?: string, isDraft?: boolean,
 *   statusCheckRollup?: Array<{ name?: string, context?: string }> }} pr
 * @param {string[]} required
 * @param {string[] | null} baseBranches - from `pullRequestBaseBranches`;
 *   `null` means the workflow carries no base filter, so nothing is base-filtered.
 */
export function classifyPr(pr, required, baseBranches) {
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
  if (baseBranches !== null && (!Array.isArray(baseBranches) || baseBranches.length === 0)) {
    throw new DirtyPrScanError(
      'EMPTY_BASE_BRANCHES',
      'The base-branch set must be a non-empty array, or `null` for "no filter". Passing an ' +
        'empty one would read every PR as base-filtered.',
    );
  }
  if (baseBranches !== null && typeof pr.baseRefName !== 'string') {
    throw new DirtyPrScanError(
      'NO_BASE_REF',
      `PR #${pr.number} carries no \`baseRefName\`, so this gate cannot tell a stacked PR ` +
        '(no lanes because of the base filter; retarget it) from a conflicted one (no lanes ' +
        'because of the merge ref; resolve it). Defaulting to either hands out a remedy that ' +
        'may not work, so it refuses instead. Add `baseRefName` to the `gh pr list --json` fields.',
    );
  }

  const rollup = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : [];
  const missing = missingLanes(required, rollup);
  const isConflicted = pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY';
  const isUnknown = pr.mergeable === 'UNKNOWN' || pr.mergeStateStatus === 'UNKNOWN';
  const isBaseFiltered = baseBranches !== null && !baseBranches.includes(pr.baseRefName);

  // Base filter first: it is the condition a merge has no power over, so it
  // names the group. It is not the whole remedy for a PR that is both --
  // retargeting a dirty PR leaves no merge ref, so still no lane -- which is
  // what `alsoConflicted` below carries into the report.
  let cause = null;
  if (missing.length > 0) {
    if (isBaseFiltered) cause = 'BASE_FILTERED';
    // A conflicted PR with every required lane present already ran them
    // before going dirty (#3417) -- not this defect.
    else if (isConflicted) cause = 'CONFLICTED';
  }

  return {
    number: pr.number,
    title: typeof pr.title === 'string' ? pr.title : '',
    url: typeof pr.url === 'string' ? pr.url : '',
    baseRefName: pr.baseRefName ?? null,
    mergeable: pr.mergeable ?? null,
    mergeStateStatus: pr.mergeStateStatus ?? null,
    isDraft: pr.isDraft === true,
    rollupCount: rollup.length,
    missing,
    cause,
    // Both remedies, not the first one. Derived from the same `isConflicted`
    // the cause ladder uses, so the two can never disagree.
    alsoConflicted: cause === 'BASE_FILTERED' && isConflicted,
    silent: cause !== null,
    // Advisory only -- see the docblock. Never folds into `silent`. A
    // base-filtered PR is a settled finding, not a pending one, so `UNKNOWN`
    // does not soften it.
    unknownAdvisory: isUnknown && !isBaseFiltered && missing.length > 0,
  };
}

/**
 * Classify every open PR in `prs` against `required`.
 *
 * @param {unknown} prs
 * @param {string[]} required
 * @param {string[] | null} baseBranches
 */
export function scanPrs(prs, required, baseBranches) {
  if (!Array.isArray(prs)) {
    throw new DirtyPrScanError(
      'BAD_INPUT',
      `Expected an array of open PRs from \`gh pr list\`; got ${typeof prs}. An unreadable list ` +
        'must never be read as "no open PRs".',
    );
  }
  return prs.map((pr) => classifyPr(pr, required, baseBranches));
}

/**
 * Render a scan into a verdict and human-readable lines.
 *
 * The two causes are reported as SEPARATE groups with separate remedies. They
 * are not interchangeable: telling a stacked PR to resolve its merge conflict
 * is advice that cannot restore a single lane, because `test.yml`'s
 * `branches:` filter still excludes its base afterwards.
 *
 * They are not mutually exclusive either. A PR that is stacked AND conflicted
 * is grouped under the base filter, but the retarget line alone would have a
 * maintainer do half the work for no lane, so `alsoConflicted` puts the second
 * remedy on that PR's own lines instead of deferring it to a later cron run.
 *
 * @param {ReturnType<typeof scanPrs>} results
 * @param {string[]} required
 * @param {string[] | null} [baseBranches]
 */
export function report(results, required, baseBranches = null) {
  const baseFiltered = results.filter((r) => r.cause === 'BASE_FILTERED');
  const conflicted = results.filter((r) => r.cause === 'CONFLICTED');
  const silent = results.filter((r) => r.silent);
  const unknownAdvisory = results.filter((r) => r.unknownAdvisory);
  const lines = [];

  /** @param {typeof results} group */
  const detail = (group) => {
    for (const r of group) {
      lines.push(
        `   #${r.number}${r.title ? ` ${r.title}` : ''}${r.url ? ` -- ${r.url}` : ''}`,
        `     base=${r.baseRefName} mergeable=${r.mergeable} ` +
          `mergeStateStatus=${r.mergeStateStatus} rollup=${r.rollupCount} row(s); ` +
          `missing ${r.missing.length}/${required.length} required lane(s): ${r.missing.join(', ')}`,
      );
      if (r.alsoConflicted) {
        lines.push(
          '     ALSO conflicted, so this one needs BOTH remedies: retargeting it clears the ' +
            'base filter but leaves the conflict, and GitHub fires no `pull_request` for a PR ' +
            'it cannot compute a merge ref for. Resolve the conflict as well, or the retarget ' +
            'restores no lane.',
        );
      }
    }
  };

  lines.push(
    `Scanned ${results.length} open PR(s) against ${required.length} required lane(s) ` +
      `derived from .github/workflows/test.yml.`,
  );

  if (silent.length === 0) {
    lines.push(
      '✅ No open PR has a required lane missing for a reason this gate can name (a base ' +
        '`test.yml` does not run on, or an unresolved merge conflict) -- this scan cannot see ' +
        'a lane that has not run yet, only one whose absence has already been reported.',
    );
  }

  if (baseFiltered.length > 0) {
    const allowed = baseBranches ? baseBranches.map((b) => `\`${b}\``).join(', ') : '(none)';
    lines.push(
      `❌ ${baseFiltered.length} open PR(s) target a base that \`test.yml\` does not run ` +
        `\`pull_request\` on (it fires only for ${allowed}), so no lane can ever report on ` +
        'them. Resolving a merge conflict will NOT fix this -- retarget the PR at a base the ' +
        'workflow runs on, or land its base branch first.',
    );
    detail(baseFiltered);
  }

  if (conflicted.length > 0) {
    lines.push(
      `❌ ${conflicted.length} open PR(s) are conflicted and have NOT run \`pull_request\` CI ` +
        'on their current head. Pushing a new commit will not fix this -- only resolving the ' +
        'conflict (merge/rebase from the base branch) restores CI.',
    );
    detail(conflicted);
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
