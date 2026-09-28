/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Turning a commit list into the rows the timeline draws.
 *
 * Pure, and deliberately separate from the panel: the ordering rules
 * (mainline first, merges marked, a page join that must not duplicate or
 * reorder anything) are the part worth testing, and testing them through a
 * rendered virtualized list would be testing the list.
 *
 * v1 renders ONE lane. `SourceCommit.parents` is plural so merge commits do
 * not need a format change later, but a merge here is a marker on the
 * mainline row, not a second lane — see `docs/architecture/commit-history/02-history-ui.md` §13.
 */

import type { SourceCommit } from '@ifc-lite/plugin-api';

export interface CommitRowModel {
  readonly commit: SourceCommit;
  /** `true` when the commit has more than one parent. Drawn as a diamond. */
  readonly isMerge: boolean;
  /** `true` when this is the model's head. */
  readonly isHead: boolean;
  /** `true` when this commit is the one currently open in the viewer. */
  readonly isLoaded: boolean;
  /** `false` for a commit reachable only through a merge's non-mainline parent. */
  readonly onMainline: boolean;
}

/**
 * Appends `incoming` to `existing`, dropping commits already present.
 *
 * A provider is free to return a commit twice across a page boundary (a new
 * commit landing mid-scroll shifts every later page by one), and React keys
 * by commit id — two rows with one key is a render that silently drops one.
 * Order is taken from the provider and never re-sorted here: `listCommits` is
 * newest-first by contract, and a client-side re-sort on `createdAt` would
 * disagree with it for same-second commits and make the list jump.
 */
export function joinCommitPages(
  existing: readonly SourceCommit[],
  incoming: readonly SourceCommit[],
): SourceCommit[] {
  if (incoming.length === 0) return [...existing];
  const seen = new Set(existing.map((commit) => commit.id));
  const joined = [...existing];
  for (const commit of incoming) {
    if (seen.has(commit.id)) continue;
    seen.add(commit.id);
    joined.push(commit);
  }
  return joined;
}

/**
 * Which commits sit on the mainline reachable from `headCommitId` by
 * following `parents[0]`.
 *
 * Only commits actually LOADED count: the chain stops where the pages stop,
 * so a model with 400 commits and one page fetched marks the 50 it has rather
 * than claiming the other 350 are off-mainline.
 */
export function mainlineIds(commits: readonly SourceCommit[], headCommitId: string): Set<string> {
  const byId = new Map(commits.map((commit) => [commit.id, commit] as const));
  const mainline = new Set<string>();
  // Falls back to the newest loaded commit when the head is not in the pages
  // fetched so far — which is the ordinary state while a long history is
  // still paging in, not an error.
  let current: SourceCommit | undefined = byId.get(headCommitId) ?? commits[0];
  while (current && !mainline.has(current.id)) {
    mainline.add(current.id);
    const parentId: string | undefined = current.parents[0];
    current = parentId !== undefined ? byId.get(parentId) : undefined;
  }
  return mainline;
}

export interface BuildRowsOptions {
  readonly commits: readonly SourceCommit[];
  readonly headCommitId: string;
  /** Commit id currently open in the viewer for this model, if any. */
  readonly loadedCommitId?: string;
}

/** The timeline's rows, in the provider's order. */
export function buildCommitRows(options: BuildRowsOptions): CommitRowModel[] {
  const mainline = mainlineIds(options.commits, options.headCommitId);
  return options.commits.map((commit) => ({
    commit,
    isMerge: commit.parents.length > 1,
    isHead: commit.id === options.headCommitId,
    isLoaded: commit.id === options.loadedCommitId,
    onMainline: mainline.has(commit.id),
  }));
}

/**
 * The two commits "Compare with loaded" resolves to, oldest as A.
 *
 * Orientation matters and is easy to get backwards: a diff reads
 * base → head, so putting the newer commit in A would report every addition
 * as a deletion. Ordering by `createdAt` rather than by which one the user
 * clicked is what makes the result the same either way round.
 */
export function orderCompareSlots(
  first: SourceCommit,
  second: SourceCommit,
): { base: SourceCommit; head: SourceCommit } {
  const firstTime = Date.parse(first.createdAt);
  const secondTime = Date.parse(second.createdAt);
  // Equal timestamps fall back to commit id, the same total order
  // `listCommits` uses, so the pair is still deterministic.
  const firstIsOlder = firstTime !== secondTime ? firstTime < secondTime : first.id < second.id;
  return firstIsOlder ? { base: first, head: second } : { base: second, head: first };
}
