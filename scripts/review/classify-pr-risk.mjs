#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Decide whether a PR is worth one of CodeRabbit's scarce reviews.
 *
 * WHY AIM AT ALL. CodeRabbit's fair usage is keyed to a developer identity on a
 * rolling window, not to a repository, and at this repo's volume it is
 * rate-limited on roughly two thirds of attempts -- measured: 27 of a 40-PR
 * sample. So its allowance is spent by WHICHEVER PRs happen to arrive when the
 * window has room, which is arrival order, which is noise. Aiming it is the only
 * lever that does not require buying more.
 *
 * WHY NOT THE OLD STAND-DOWN. The previous attempt skipped any PR the Claude
 * lane had covered. Measured on live traffic: 21 PRs stood CodeRabbit down on a
 * `clean` verdict while the lane's total findings across them was ZERO. It did
 * not redistribute the allowance, it FORFEITED it -- the lane covers nearly
 * everything, so almost nothing was left to redistribute to. This aims by what
 * the diff IS, which does not depend on either reviewer's opinion of it.
 *
 * THE DIRECTION OF THE ERROR IS CHOSEN. A misclassified low-risk PR loses a
 * CodeRabbit review; a misclassified high-risk PR wastes one. The first is worse,
 * so the classifier only calls a PR low-risk when EVERY file it touches is
 * something nobody reviews line-by-line anyway, and anything it does not
 * recognise counts as high-risk. There is no "probably fine".
 *
 * TESTS ARE NOT LOW-RISK, deliberately, and this is the one that looks wrong.
 * This repository's own memory is a taxonomy of tests that cannot fail: oracles
 * sharing the defect under test, expected values derived from the code under
 * test, ratio assertions trivially true at zero, mutations that never applied. A
 * test-only diff is exactly where a second reader pays, so it is high-risk here
 * even though many repositories would call it noise.
 */
import { readFileSync, appendFileSync } from 'node:fs';
import { isExcluded } from './build-review-input.mjs';

/**
 * Paths nobody reviews line-by-line, beyond the generated/vendored set the lane
 * already refuses to send a model.
 *
 * Deliberately NARROW. `docs/` and `*.md` are here because a prose change cannot
 * break a build; `.changeset/` is NOT, because a changeset naming a package that
 * does not exist fails the release workflow, which only runs on main -- the exact
 * class that cost this repo twelve wrong version bumps in #3175.
 */
const LOW_RISK_EXTRA = [
  /^docs\//,
  /\.md$/i,
  /^\.github\/ISSUE_TEMPLATE\//,
  /(^|\/)CODEOWNERS$/,
  /(^|\/)\.gitignore$/,
];

/**
 * Paths that are NEVER low-risk, whatever else matches them. This list wins.
 *
 * IT EXISTS BECAUSE THE FIRST VERSION WAS WRONG. `.changeset/nice-cats.md` is a
 * markdown file, so `/\.md$/i` classified a changeset as prose -- the one class
 * the docblock above singles out as dangerous, because a changeset naming a
 * package that does not exist fails the RELEASE workflow, which only runs on
 * main. That is #3175: twelve wrong version bumps. Caught by the classifier's own
 * test, which is the only reason this note is here rather than in an incident.
 *
 * A narrow rule stated in prose and a broad pattern in code is the shape this
 * repository keeps paying for. The prose is now executable.
 */
const NEVER_LOW_RISK = [
  /^\.changeset\//,
  /^\.github\/workflows\//,
];

/**
 * @param {string} path
 *
 * LOW-RISK MEANS "CODERABBIT MAY SKIP THIS BECAUSE THE CLAUDE LANE WILL READ
 * IT". It does not mean "unimportant", and the first version got that backwards
 * in a way that would have left PRs reviewed by nobody.
 *
 * That version wrote `isExcluded(path) || ...`, borrowing the lane's own
 * exclusion list. But `isExcluded` answers a DIFFERENT question -- "is it worth
 * spending model tokens on this" -- and it covers `fixtures/`, `pkg/`, `dist/`,
 * `.snap` and lockfiles, all of which the LANE ALSO SKIPS: `claude-review.yml`
 * turns them into `NO_FILES` and never runs the model. So a fixtures-only or
 * `Cargo.lock`-only PR would have had CodeRabbit labelled off AND no Claude
 * review -- reviewed by nobody, while the workflow printed "the Claude lane
 * still reviews it". Absence reading as success, in the read-back step added to
 * prevent exactly that. PR #3558 is a live instance of the lockfile shape.
 *
 * So the two predicates are ANDed, not ORed: a path is low-risk only when it is
 * prose AND the lane will actually review it. Anything the lane skips is
 * high-risk by construction, because there CodeRabbit is the only reader left.
 */
export function isLowRiskPath(path) {
  if (NEVER_LOW_RISK.some((re) => re.test(path))) return false;
  if (isExcluded(path)) return false;
  return LOW_RISK_EXTRA.some((re) => re.test(path));
}

/**
 * @param {string[]} paths - every file the PR touches.
 * @returns {{ lowRisk: boolean, why: string }}
 */
export function classify(paths) {
  if (!Array.isArray(paths) || paths.length === 0) {
    // A PR whose file list could not be read is NOT low risk. Reading "no files"
    // as "nothing risky" is the absence-reads-as-success shape, and here it would
    // silently spend the allowance on nothing while skipping real work.
    return { lowRisk: false, why: 'no file list was readable, so this is treated as high risk' };
  }
  const risky = paths.filter((p) => !isLowRiskPath(p));
  if (risky.length === 0) {
    return {
      lowRisk: true,
      why: `all ${paths.length} path(s) are generated, vendored or prose`,
    };
  }
  return {
    lowRisk: false,
    why: `${risky.length} of ${paths.length} path(s) need review, starting with \`${risky[0]}\``,
  };
}

function main() {
  const raw = process.argv[2];
  if (!raw) {
    console.error('usage: classify-pr-risk.mjs <newline-separated-paths-file>');
    process.exit(2);
  }
  const paths = readFileSync(raw, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  const v = classify(paths);
  console.log(`${v.lowRisk ? 'low-risk' : 'needs-review'}: ${v.why}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `low_risk=${v.lowRisk ? 'true' : 'false'}\n`);
  }
}

if (process.argv[1] && process.argv[1].endsWith('classify-pr-risk.mjs')) {
  main();
}
