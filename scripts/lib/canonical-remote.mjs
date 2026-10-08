/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which ref a base-judging script compares against when it is given none
 * (#7031): the `main` of the remote whose URL is the canonical repository,
 * `LTplus-AG/ifc-lite`, found by URL and not by name.
 *
 * `origin` is the canonical repository in an Actions checkout of it. On a
 * contributor clone that follows the fork workflow `origin` is the fork and
 * the canonical repository is another remote (commonly `upstream`). A gate
 * that hard-codes `origin/main` then judges the branch against the fork's
 * main, which can be thousands of commits behind, with full confidence.
 *
 * What each situation resolves to:
 *
 *   canonical-origin      `origin` points at LTplus-AG/ifc-lite (every Actions
 *                         checkout of it)           -> `origin/main`, the
 *                         string every caller used before this helper existed.
 *   fork-origin           `origin` is a fork, another remote points at
 *                         LTplus-AG/ifc-lite        -> `<that remote>/main`.
 *   explicit-base         the caller was given a ref (`--base <ref>`)
 *                                                   -> this helper is not
 *                         consulted; the ref is used as given.
 *   no-canonical-remote   no remote points at LTplus-AG/ifc-lite (a fork's own
 *                         Actions run, a mirror, not a repository at all)
 *                                                   -> `origin/main`, the old
 *                         default. Never a skip: a fork's own CI keeps judging
 *                         against its own main.
 *   unfetched-ref         the canonical remote exists but its `main` has not
 *                         been fetched              -> still `<remote>/main`.
 *                         This helper only NAMES the ref; whether it resolves
 *                         is each caller's existing business (fall back and
 *                         warn, or fail), and the caller names the ref that
 *                         was wanted so the remedy is `git fetch <remote> main`.
 *
 * When two remotes point at the canonical repository, `origin` wins if it is
 * one of them (the answer CI gets); otherwise the first listed.
 */

import { spawnSync } from 'node:child_process';

/**
 * `LTplus-AG/ifc-lite` must be the WHOLE path: directly after github.com
 * (`scheme://[user@]host/` or scp-style `[user@]host:`), so a fork whose path
 * merely contains it (`someone/LTplus-AG/ifc-lite`) and a look-alike owner
 * (`Evil-LTplus-AG/ifc-lite`) do not match; an optional `.git` and trailing
 * slash may follow. GitHub paths are case-insensitive.
 */
const CANONICAL_FETCH_LINE = /^(\S+)\s+(?:[a-z][a-z0-9+.-]*:\/\/(?:[^/\s@]+@)?github\.com(?::[0-9]+)?\/|(?:[^/\s@:]+@)?github\.com:)LTplus-AG\/ifc-lite(?:\.git)?\/?\s+\(fetch\)$/i;

/**
 * The remote in `git remote -v` output whose FETCH URL is the canonical
 * repository, or `null`. `origin` is preferred when several qualify.
 *
 * @param {string} remoteVerbose output of `git remote -v`
 * @returns {string | null}
 */
export function findCanonicalRemote(remoteVerbose) {
  const names = [];
  for (const line of remoteVerbose.split('\n')) {
    const match = CANONICAL_FETCH_LINE.exec(line.trim());
    if (match) names.push(match[1]);
  }
  if (names.length === 0) return null;
  return names.includes('origin') ? 'origin' : names[0];
}

/**
 * `<canonical remote>/main`, or `origin/main` when no remote is canonical.
 *
 * @param {string} remoteVerbose output of `git remote -v`
 */
export function canonicalMainRef(remoteVerbose) {
  return `${findCanonicalRemote(remoteVerbose) ?? 'origin'}/main`;
}

/** `canonicalMainRef` for the repository at `root`; an unreadable `git remote -v` gives the `origin/main` default. */
export function canonicalMainRefIn(root) {
  const res = spawnSync('git', ['remote', '-v'], { cwd: root, encoding: 'utf8' });
  return canonicalMainRef(res.status === 0 ? res.stdout : '');
}
