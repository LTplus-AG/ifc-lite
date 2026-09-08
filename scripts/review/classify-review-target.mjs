#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { isMainEntry } from '../lib/is-main-entry.mjs';

const RELEASE_BRANCH = 'changeset-release/main';
const RELEASE_TITLE = 'chore: version packages';

/**
 * Decide whether a PR contains authored code for the probabilistic reviewer.
 * Near-matches fail closed onto the normal review path: a branch name alone is
 * not enough to turn an arbitrary PR into a generated release artifact.
 */
export function classifyReviewTarget({ headRef, title }) {
  if (headRef === RELEASE_BRANCH && title === RELEASE_TITLE) {
    return {
      skip: true,
      reason:
        'Generated changesets release PR: package versions and changelogs are validated by the deterministic release, changeset, API-surface, build, and test gates.',
    };
  }
  return { skip: false, reason: null };
}

function main() {
  const args = process.argv.slice(2);
  const value = (flag) => {
    const i = args.indexOf(flag);
    if (i < 0 || args[i + 1] === undefined) throw new Error(`${flag} requires a value`);
    return args[i + 1];
  };
  process.stdout.write(`${JSON.stringify(classifyReviewTarget({ headRef: value('--head-ref'), title: value('--title') }))}\n`);
}

if (isMainEntry(import.meta.url)) main();
