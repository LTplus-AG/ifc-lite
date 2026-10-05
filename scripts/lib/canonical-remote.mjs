/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which local remote is the canonical repository (`LTplus-AG/ifc-lite`), found
 * by URL and not by name. CI's checkout names the canonical repository
 * `origin`; a contributor machine often has `origin` pointing at a stale fork
 * and the canonical repository under `upstream`. A script test that judges the
 * branch against the checker's default `origin/main` is then judged against a
 * base months behind.
 */

import { spawnSync } from 'node:child_process';

/**
 * `LTplus-AG/ifc-lite` must be the WHOLE path: directly after the host
 * (`scheme://[user@]host/` or scp-style `[user@]host:`), so `Evil-LTplus-AG/...`
 * and `BIMvoice/LTplus-AG/...` do not match, followed by an optional `.git` and
 * trailing slash. GitHub paths are case-insensitive.
 */
const CANONICAL_FETCH_LINE = /^(\S+)\s+(?:[a-z][a-z0-9+.-]*:\/\/[^/\s]+\/|[^/\s]+:)LTplus-AG\/ifc-lite(?:\.git)?\/?\s+\(fetch\)$/i;

/** The first remote in `git remote -v` output whose fetch URL is the canonical repository, or `null`. */
export function findCanonicalRemote(remoteVerbose) {
  for (const line of remoteVerbose.split('\n')) {
    const match = CANONICAL_FETCH_LINE.exec(line.trim());
    if (match) return match[1];
  }
  return null;
}

/**
 * What to pass `check-module-size` so it judges against the canonical main:
 * `{ args }` to run, or `{ skip }` when this host has no such remote and is not
 * CI. On CI with no such remote (a fork's Actions run, where `origin` IS the
 * fork's own main) the checker keeps its default, `args: []`.
 *
 * @param {string} remoteVerbose output of `git remote -v`
 * @param {boolean} onCI result of `isCI()`
 */
export function canonicalBaseArgs(remoteVerbose, onCI) {
  const remote = findCanonicalRemote(remoteVerbose);
  if (remote !== null) return { args: ['--base', `${remote}/main`] };
  if (onCI) return { args: [] };
  return { skip: 'no remote points at LTplus-AG/ifc-lite, so there is no canonical main to judge allowlist rows against (add one and fetch it). CI never skips this test.' };
}

/**
 * The ref the base-judging scripts compare against: `<canonical remote>/main`
 * when some remote points at `LTplus-AG/ifc-lite`, else the long-standing
 * default `origin/main`. With `origin` pointing at the canonical repository
 * (every Actions checkout of it) the answer is the string it always was.
 * The no-canonical-remote fallback is deliberately the old default, never a
 * skip, so a fork's own Actions run keeps judging against its own main.
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
