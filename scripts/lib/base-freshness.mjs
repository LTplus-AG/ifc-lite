/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure core of the base-freshness signal (issue #3726). No I/O, no `gh`, no
 * `git` -- everything here is a function of file lists and file text, so the
 * verdict is testable without a network and replayable over history.
 *
 * See `scripts/check-base-freshness.mjs` for what the verdict means and why it
 * is narrowed the way it is.
 */

/**
 * A repo-relative path token: at least one `/`, and an extension. Deliberately
 * greedy about the characters a path may hold (`@`, `.`, `-`) because package
 * dirs use all three. Tokens are checked against the real tree afterwards, so a
 * false match that is not a file costs nothing.
 */
const PATH_TOKEN = /(?:[A-Za-z0-9_.@+-]+\/)+[A-Za-z0-9_.@+-]+\.[A-Za-z0-9]+/g;

/**
 * The repo paths a snapshot file RECORDS, i.e. the files whose measurement it
 * pins. Scans the raw text rather than parsing a format: the snapshots here
 * come in three shapes (`<budget> <path>`, `<path> # note`,
 * `<path> <fragment> # note`) plus JSON, and a text scan reads all of them
 * without a per-format parser to keep in sync.
 *
 * `isRepoFile` must answer for a FILE, not a directory. Directory-granular
 * snapshots (`scripts/unused-locals-baseline.json` records `apps/viewer`) are
 * excluded on purpose: their input set is a whole package, so coupling on them
 * would fire for nearly every pair of PRs, which is the blanket enforcement the
 * measurement in #3726 rejects.
 */
export function recordedFiles(text, isRepoFile) {
  const found = new Set();
  for (const rawLine of text.split('\n')) {
    // A recorded row is the head of its line; everything from the first `#` is
    // a note. Notes here cite OTHER files ("see scripts/check-module-size.mjs",
    // "the gate reads .github/workflows/release.yml"), and counting those as
    // pinned inputs would widen the set with files the snapshot does not
    // measure -- the direction that invents false couplings.
    const line = rawLine.split('#')[0];
    for (const match of line.matchAll(PATH_TOKEN)) {
      const path = match[0];
      if (isRepoFile(path)) found.add(path);
    }
  }
  return found;
}

/**
 * Find the committed whole-tree snapshots by scanning the tree, not by keeping
 * a hand-written list. A list would rot silently the first time someone adds a
 * seventh allowlist, and the gate would go on passing.
 *
 * A tracked `.txt`/`.json` whose name carries `allowlist` or `baseline` and
 * which names at least one real file is a snapshot. One that names none
 * (`refwalk-guard-allowlist.txt` is empty; `tests/benchmark/baseline.json` is
 * keyed by model name) cannot couple anything and is dropped.
 */
export function discoverSnapshots({ trackedFiles, readFile, isRepoFile }) {
  const snapshots = [];
  for (const path of trackedFiles) {
    if (!/\.(txt|json)$/.test(path)) continue;
    if (!/(allowlist|baseline)/i.test(path)) continue;
    const inputs = recordedFiles(readFile(path), isRepoFile);
    if (inputs.size === 0) continue;
    snapshots.push({ path, inputs });
  }
  return snapshots;
}

const intersect = (files, set) => files.filter((f) => set.has(f));

/**
 * The recorded paths whose ROWS a unified diff of a snapshot adds or removes.
 *
 * Row granularity is what keeps the `main-recorded` direction honest. Measured
 * 2026-09-02 over the 55 then-open PRs, whole-file granularity called 21 of
 * them stale purely because #3723 had just re-recorded
 * `module-size-allowlist.txt`: that edit moved rows for six `scripts/review/`
 * files, and it flagged every PR touching any pinned file at all. A row main
 * did not move cannot invalidate a PR that edits the file that row pins,
 * because both lanes measured that file against the same budget.
 */
export function rowsChangedInPatch(patch, isRepoFile) {
  const changed = new Set();
  for (const line of (patch ?? '').split('\n')) {
    if (!/^[+-]/.test(line) || /^(\+\+\+|---)/.test(line)) continue;
    for (const path of recordedFiles(line.slice(1), isRepoFile)) changed.add(path);
  }
  return changed;
}

/**
 * The verdict.
 *
 * STALE for a snapshot S when the PR and the commits main gained since the PR
 * was tested are COUPLED THROUGH S:
 *
 *   - the PR re-records S while main changed a file S pins (the PR's snapshot
 *     was taken from a tree that lacks main's change), or
 *   - main MOVED A ROW in S for a file the PR changes (main's row was measured
 *     on a tree that lacks the PR's change).
 *
 * Both directions of the #3726 incident are in there: #3689 re-recorded
 * `module-size-allowlist.txt` after #3668 grew three files it pins, and #3686
 * then grew files it pins after #3689 had re-recorded it.
 */
export function evaluateFreshness({ prFiles, movedFiles, snapshots, rowsChangedOnMain }) {
  const pr = new Set(prFiles);
  const moved = new Set(movedFiles);
  const couplings = [];

  for (const { path, inputs } of snapshots) {
    const prTouchesSnapshot = pr.has(path);
    const mainTouchesSnapshot = moved.has(path);
    const mainInputs = intersect(movedFiles, inputs);
    // Rows main moved, when the diff was readable. GitHub omits `patch` for a
    // large file, so the fallback is the whole pinned set: over-reporting is
    // visible and arguable, an omission is neither.
    const movedRows = rowsChangedOnMain?.get(path) ?? inputs;
    const prMovedRows = intersect(prFiles, movedRows);

    let direction = null;
    let overlap = [];
    if (prTouchesSnapshot && mainInputs.length > 0) {
      direction = 'pr-recorded';
      overlap = mainInputs;
    } else if (mainTouchesSnapshot && prMovedRows.length > 0) {
      direction = 'main-recorded';
      overlap = prMovedRows;
    } else if (prTouchesSnapshot && mainTouchesSnapshot) {
      direction = 'both-recorded';
    }
    if (direction) couplings.push({ snapshot: path, direction, overlap });
  }

  return { stale: couplings.length > 0, couplings };
}

/** One line per verdict, and the two lines must not be confusable. */
export function formatVerdict({ pr, baseSha, commitsBehind, movedFileCount, result }) {
  const base = baseSha ? baseSha.slice(0, 9) : 'unknown';
  const head = `PR #${pr} was tested against ${base}; main has gained ${commitsBehind} commit(s) touching ${movedFileCount} file(s) since.`;
  if (!result.stale) {
    return `base-freshness: OK -- ${head} None of them couples to a whole-tree snapshot this PR records or is recorded by.`;
  }
  const why = result.couplings
    .map(({ snapshot, direction, overlap }) => {
      if (direction === 'truncated') {
        return 'the base moved past what GitHub will compare (250 commits), so no snapshot could be checked; rebase';
      }
      if (direction === 'both-recorded') {
        return `${snapshot}: this PR and main each re-recorded it, from two different trees`;
      }
      const who = direction === 'pr-recorded' ? 'this PR re-records' : 'main re-recorded';
      const side = direction === 'pr-recorded' ? 'main changed' : 'this PR changes';
      const shown = overlap.slice(0, 4).join(', ');
      const more = overlap.length > 4 ? ` (+${overlap.length - 4} more)` : '';
      return `${snapshot}: ${who} it, and ${side} ${shown}${more}, which it pins`;
    })
    .join('; ');
  return `base-freshness: STALE -- ${head} ${why}. The recorded snapshot predates the other side, so a green verdict here does not carry to main: rebase and re-record before merging.`;
}
