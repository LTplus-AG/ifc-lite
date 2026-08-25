#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Which commit published version X?" — the commit `.github/workflows/release.yml`
 * must name when it creates a `v*` tag.
 *
 * WHY THIS EXISTS. Both `v*` tags used to be created as `git tag "v${VERSION}"`
 * with no commit-ish, and `git tag <name>` with no object tags the CURRENT
 * CHECKOUT HEAD. The release job checks out with no `ref:`, so HEAD is the
 * commit that TRIGGERED the run — and every push to `main` triggers a Release
 * run, which publishes whatever is unpublished and then tags at its own trigger
 * commit. A correct tag was therefore only ever a coincidence: it held when the
 * triggering commit happened to be the version commit, and not otherwise.
 *
 * It stopped holding twice, both verified in the repository (#3209):
 *
 *   v6.0.1  tagged a5ba0d80 ("test(mcp): a 627-line tool surface with no test
 *           file") instead of the version commit 989da893 ("chore: version
 *           packages"). The version commit's own run was cancelled by the
 *           `concurrency:` group; a later push-run did the tagging fourteen
 *           minutes on. Corrected by hand since.
 *
 *   v1.16.7 still points at db35b4a6, 35 commits after 44c4201e, which is where
 *           `packages/server-bin`'s version was actually set. Both commits
 *           REPORT 1.16.7 — the version did not move in between — which is
 *           exactly why a wrong tag is invisible unless someone goes looking.
 *
 * The damage is not cosmetic. `packages/server-bin/src/binary.ts` builds its
 * download URL from the `v*` tag, and `server-binaries.yml` uploads the
 * per-platform archives against whatever commit the tag names. A tag on the
 * wrong commit means the archives and the npm package resolving to them were
 * built from different trees.
 *
 * WHY NOT `git log -S`. The obvious spelling, `git log -S'"version": "6.0.0"'`,
 * is wrong in a way reasoning does not catch and a test does: `-S` matches
 * commits where the string's COUNT changed, so the commit that REMOVED the
 * 6.0.0 line — the 6.0.1 bump — qualifies exactly as much as the one that
 * added it. On this repo it returns the NEXT release's commit.
 *
 * WHAT WORKS. Walk `git log -- <manifest>` newest-first and take the OLDEST
 * commit in the newest contiguous run whose manifest reports the target
 * version: the commit that bumped TO it, rather than the last one that
 * happened to touch the file afterwards. Checked against real history — the
 * run reporting 1.16.7 is `db35b4a6 … 9abf93f3, 44c4201e`, whose oldest member
 * is 44c4201e, and the same walk yields `v6.0.1 -> 989da893`,
 * `v6.0.0 -> ec358164` and `v5.0.0 -> b314b66c`.
 *
 * The walk needs real history, which the release job has: its checkout uses
 * `fetch-depth: 0`. Under a shallow checkout the walk would end at the graft
 * boundary, and this exits non-zero rather than answering from a truncated log.
 *
 * AS A CLI: `node scripts/release-tag-commit.mjs <manifest> <version> [tag]`
 * prints the resolved commit SHA on stdout and nothing else. When `tag` is
 * given and that tag already exists, its target is compared against the
 * resolved commit and a MISMATCH exits non-zero — the tag is left untouched.
 * That is deliberate: a tag that is absent is a visible problem, a tag on the
 * wrong commit is a silent one, and everything downstream treats it as
 * authoritative. Failing loudly is what turns the `v1.16.7` damage above into
 * a red job instead of another quiet success.
 *
 * The workflow consumes this as `VERSION_COMMIT=$(node scripts/release-tag-commit.mjs …)`.
 * Under the Actions default shell (`bash --noprofile --norc -eo pipefail`) a
 * bare assignment from a command substitution takes the substitution's exit
 * status, so a non-zero exit here kills the step before anything is pushed.
 * That direction is intended, and is the opposite of the fail-OPEN wanted at
 * the `version_changed` seam.
 *
 * Executable proof: `scripts/release-tag-commit.test.mjs`, which drives real
 * throwaway git repositories and lifts the tagging lines out of `release.yml`
 * rather than restating them.
 */

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** `git` in `repo`, trimmed stdout; throws on non-zero. */
function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/**
 * The `version` field of `manifest` as of `rev`, or `null` when the file did
 * not exist there or does not parse.
 *
 * `null` rather than a throw: an unreadable manifest at some ancestor commit
 * only means that commit is not the bump, and the walk must keep going. The
 * target version is never inferred from an absence — `resolveVersionCommit`
 * fails outright when no commit reports it.
 */
export function versionAtRev(repo, rev, manifest) {
  let text;
  try {
    text = execFileSync('git', ['show', `${rev}:${manifest}`], {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    return typeof parsed?.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * The commit that set `manifest`'s version to `version`.
 *
 * Newest-first over the commits that touched `manifest`; the answer is the
 * OLDEST commit of the newest contiguous run reporting `version`. A version
 * that was set, abandoned and set again therefore resolves to the LATEST bump
 * to it, which is the one whose publish a tag would be recording.
 *
 * @throws when no commit in the walked history reports `version`.
 */
export function resolveVersionCommit(repo, manifest, version) {
  const history = git(repo, ['log', '--format=%H', '--', manifest]).split('\n').filter(Boolean);
  let bump = null;
  for (const sha of history) {
    if (versionAtRev(repo, sha, manifest) === version) {
      // Still inside the run — keep walking back, so this ends on its oldest.
      bump = sha;
    } else if (bump !== null) {
      // One commit past the run: the version differs here, so the commit after
      // this one is where it was set.
      break;
    }
  }
  if (bump === null) {
    throw new Error(
      `No commit in the history of ${manifest} reports version ${version}. ` +
        `Either the version was never committed, or this is a shallow checkout ` +
        `(the release job needs \`fetch-depth: 0\`).`,
    );
  }
  return bump;
}

/** The commit a tag names (peeled through an annotated tag), or `null`. */
export function tagTarget(repo, tag) {
  try {
    return git(repo, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`]);
  } catch {
    return null;
  }
}

const invokedDirectly =
  process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const [manifest, version, tag] = process.argv.slice(2);
  if (!manifest || !version) {
    console.error('usage: node scripts/release-tag-commit.mjs <manifest> <version> [tag]');
    process.exit(2);
  }
  const repo = process.cwd();
  let commit;
  try {
    commit = resolveVersionCommit(repo, manifest, version);
  } catch (err) {
    console.error(`\n${err.message}\n`);
    process.exit(1);
  }

  if (tag) {
    const existing = tagTarget(repo, tag);
    if (existing !== null && existing !== commit) {
      console.error(
        `\nTag ${tag} already exists and names the WRONG commit.\n\n` +
          `  tag ${tag} -> ${existing}\n` +
          `  ${manifest} was set to ${version} at ${commit}\n\n` +
          `Refusing to reuse it. Downstream treats this tag as authoritative: ` +
          `packages/server-bin/src/binary.ts builds its download URL from it and ` +
          `server-binaries.yml uploads the per-platform archives against whatever ` +
          `commit it names, so the archives and the package resolving to them would ` +
          `come from different trees (#3209).\n\n` +
          `Fix the ref deliberately, then re-run:\n\n` +
          `  git tag -f ${tag} ${commit} && git push --force origin refs/tags/${tag}\n`,
      );
      process.exit(1);
    }
  }

  process.stdout.write(`${commit}\n`);
}
