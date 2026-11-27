/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { spawnSync } from 'node:child_process';

const COMPARE_FILE_CAP = 300;
const COMPARE_COMMIT_CAP = 250;

/**
 * A `compare` response to main's moved paths. `compare` caps files at 300 and
 * drops them past 250 commits: that is reported as capped, never as "nothing
 * moved". The cap counts entries, not the two paths a rename expands to.
 */
export function compareMoved(cmp) {
  const capped = !cmp.files || cmp.files.length >= COMPARE_FILE_CAP || cmp.total_commits >= COMPARE_COMMIT_CAP;
  return { files: cmp.files ? changedPaths(cmp.files) : [], commits: cmp.total_commits, capped };
}

/** `pulls/<n>/files` entries to paths: a rename counts at both ends, or a move out of a crate hides it. */
export function changedPaths(entries) {
  return entries.flatMap((f) => (f.previous_filename ? [f.filename, f.previous_filename] : [f.filename]));
}

export function createDiffReaders({ repo, cwd, api, git, haveCommit, pull, prFileCache, stats }) {
  /** Main's changed files since `base`: local git when both ends are present, else `compare`. */
  function movedSince(base, tip) {
    if (haveCommit(base) && haveCommit(tip)) {
      // A base that is not behind the tip (a replay against an older main)
      // would give a reversed diff: that is no answer, not an empty one.
      if (spawnSync('git', ['merge-base', '--is-ancestor', base, tip], { cwd }).status !== 0) return null;
      // --no-renames: a move lists its old path too (a crate main moved a file
      // out of still changed), and rename detection would fetch blobs.
      // -z: raw path bytes, not C-quoted ones a non-ASCII name would get.
      const files = git(['diff', '--name-only', '-z', '--no-renames', `${base}..${tip}`]).split('\0').filter(Boolean);
      const commits = Number(git(['rev-list', '--count', `${base}..${tip}`]));
      return { files, commits, capped: false };
    }
    const cmp = api(`repos/${repo}/compare/${base}...${tip}`, `main's changes since ${base}`);
    if (cmp.status !== 'ahead' && cmp.status !== 'identical') return null;
    return compareMoved(cmp);
  }

  /**
   * The PR's changed files (REST, paginated; GitHub stops at 3,000), with a
   * renamed file's old path too. Counted as one call per page.
   *
   * `pulls/<n>/files` lists the PR as it is NOW, not a pinned revision, so
   * the list is bound to the head, base branch and base commit it describes.
   * A base that lands an ancestor of an unchanged head can move the merge base.
   * Use the sweep's base snapshot when known, and check it after paging.
   */
  function prFiles(number, headSha = null, baseRef = null, baseSha = null) {
    const readRevision = () => {
      const current = pull(number);
      if (current.head?.sha !== headSha) throw new Error(`PR #${number} moved to ${String(current.head?.sha).slice(0, 9)} while its files were read`);
      if (baseRef && current.base?.ref !== baseRef) throw new Error(`PR #${number} was retargeted to ${current.base?.ref} while its files were read`);
      if (!current.base?.ref || !current.base.sha) throw new Error(`PR #${number} has no base revision for its file list`);
      return current.base;
    };
    if (headSha && (!baseRef || !baseSha)) {
      const base = readRevision();
      baseRef ??= base.ref;
      baseSha ??= base.sha;
    }
    const key = headSha ? `${headSha}#${number}@${baseRef}` : null;
    const cached = key && prFileCache[key];
    if (cached?.baseSha === baseSha && Array.isArray(cached.files)) {
      stats.cacheHits += 1;
      return cached.files;
    }
    const files = [];
    for (let page = 1; ; page += 1) {
      const entries = api(`repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`, `files of PR #${number}`);
      files.push(...changedPaths(entries));
      if (entries.length < 100) break;
      // GitHub lists at most 3,000 files: a full 30th page may hide the rest,
      // and a prefix read as the whole list could call a Rust PR not relevant.
      if (page >= 30) throw new Error(`PR #${number} changes 3,000+ files; GitHub does not list them all`);
    }
    if (key) {
      if (readRevision().sha !== baseSha) throw new Error(`PR #${number} base advanced while its files were read`);
      prFileCache[key] = { baseSha, files };
    }
    return files;
  }

  return { movedSince, prFiles };
}
