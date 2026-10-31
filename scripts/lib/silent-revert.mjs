/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure logic of `scripts/check-silent-revert.mjs`: given the net change a PR
 * will make to its base and the recent commits on that base, say which merged
 * commits the PR undoes. No git, no I/O -- the caller supplies maps of
 * `path -> { old, new }` blob ids, so every rule here is testable on literals.
 *
 * THE INCIDENT. #8377, a viewer feature, merged as 705eb56357 and put 14
 * non-viewer files of #8360 (eaddb03505) back to their exact pre-#8360 blobs,
 * deleting `affine_classify.rs` with them. Neither title mentioned it. Every
 * lane was green because each lane judges the tree, and the reverted tree was
 * a consistent earlier tree.
 *
 * THE SIGNAL. A file whose merged blob is byte-identical to the blob it had
 * BEFORE a commit that is already on the base is not "edited toward something":
 * it is that commit's change taken back. One file can be a coincidence (a
 * toggled baseline, a version string). Three or more files of one commit
 * returning to their exact earlier bytes is not.
 *
 * WHAT COUNTS (see `classify`).
 *   restored   C modified the file, the PR puts back C's pre-image.
 *   re-added   C deleted the file, the PR brings back its exact bytes.
 *   removed    C CREATED the file, the PR deletes it. NOT counted: it is the
 *              ordinary lifecycle of scaffolding, evidence and changesets
 *              ("supersede means delete"), and the release PR does it to
 *              every consumed changeset. Over the last 1500 commits of main,
 *              12 PR/commit pairs deleted three or more files the earlier
 *              commit had created (release PRs, a refactor superseding the
 *              files it replaced, a bytecode-cache cleanup): none was a revert.
 *
 * UN-REVERTING IS NOT REVERTING. If C itself had moved the file back to an
 * older state (C's new blob is some earlier commit's pre-image), a PR that
 * undoes C on that file is repairing a revert, or re-landing one. Measured:
 * the PR that repaired #8377 (6b66b109c5) restored 7 files to their pre-#8377
 * blobs and must pass. Those files are dropped from the count.
 */

export const DEFAULT_WINDOW = 100;
export const DEFAULT_MIN_FILES = 3;
export const EXEMPT_LABEL = 'silent-revert-exempt';

const isZero = (oid) => /^0+$/.test(oid);

/**
 * Parse `git diff-tree -r -z --no-renames --no-commit-id` output.
 * Entries are `:<mode> <mode> <old> <new> <status>\0<path>\0`.
 * @returns {Map<string,{old:string,new:string}>}
 */
export function parseRawDiffZ(text) {
  const parts = text.split('\0');
  const out = new Map();
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i];
    if (!meta.startsWith(':')) throw new Error(`unparseable diff-tree record ${JSON.stringify(meta.slice(0, 40))}`);
    const fields = meta.slice(1).split(' ');
    if (fields.length < 5) throw new Error(`short diff-tree record ${JSON.stringify(meta.slice(0, 80))}`);
    out.set(parts[i + 1], { old: fields[2], new: fields[3] });
  }
  return out;
}

/** Subject of a squash commit: the PR number in a trailing `(#1234)`. */
export function prNumberOf(subject) {
  const m = /\(#(\d+)\)\s*$/.exec(subject);
  return m ? Number(m[1]) : null;
}

/**
 * Compare one commit's changes with the PR's net change.
 *
 * @param {Map<string,{old:string,new:string}>} net the PR's merged-tree change vs its base
 * @param {{changes: Map}} commit a commit on the base
 * @param {Map<string,Array<{old:string}>>} olderByPath pre-images of the commits OLDER than
 *   `commit` that touched each of its paths
 */
function classify(net, commit, olderByPath) {
  const strong = [];
  const lifecycle = [];
  const unreverted = [];
  for (const [path, c] of commit.changes) {
    const d = net.get(path);
    if (!d || d.old === d.new || d.new !== c.old) continue;
    // C's own change was a return to an older state: undoing C here repairs it.
    // An all-zero id is "no file", not a state: A creating a file and B deleting it
    // share zeros for A's pre-image and B's result, which would file a PR that
    // silently re-adds B's deleted files as "repairing a revert" and pass it.
    const earlier = olderByPath.get(path) ?? [];
    if (!isZero(c.new) && earlier.some((e) => e.old === c.new)) { unreverted.push(path); continue; }
    if (isZero(c.old)) lifecycle.push(path);
    else strong.push({ path, kind: isZero(c.new) ? 're-added' : 'restored' });
  }
  return { strong, lifecycle, unreverted };
}

/**
 * @param {object} p
 * @param {Map<string,{old:string,new:string}>} p.net
 * @param {Array<{sha:string,subject:string,changes:Map}>} p.commits newest first; the
 *   first `p.attributable` are candidates, the rest are look-behind for the un-revert rule
 * @param {number} p.attributable
 * @param {number} [p.minFiles]
 */
export function findSilentReverts({ net, commits, attributable, minFiles = DEFAULT_MIN_FILES }) {
  // path -> pre-images of every commit that touched it, with the commit's index.
  const byPath = new Map();
  commits.forEach((c, index) => {
    for (const [path, ch] of c.changes) {
      if (!byPath.has(path)) byPath.set(path, []);
      byPath.get(path).push({ index, old: ch.old });
    }
  });
  const found = [];
  for (let i = 0; i < Math.min(attributable, commits.length); i += 1) {
    const commit = commits[i];
    const older = new Map();
    for (const path of commit.changes.keys()) {
      older.set(path, (byPath.get(path) ?? []).filter((e) => e.index > i));
    }
    const { strong, lifecycle, unreverted } = classify(net, commit, older);
    if (strong.length < minFiles) continue;
    found.push({
      sha: commit.sha,
      subject: commit.subject,
      pr: prNumberOf(commit.subject),
      distance: i + 1,
      touched: commit.changes.size,
      restored: strong,
      lifecycle,
      unreverted,
    });
  }
  return found.sort((a, b) => b.restored.length - a.restored.length);
}

/**
 * How a PR declares that it means to undo merged work.
 *   - a title that IS a revert exempts all. Only the shapes reverts are titled in:
 *     `revert(scope): ...`, `revert: ...` and `Revert "..."`. Prose that merely starts
 *     with the word (`Revert button is broken`) declares nothing,
 *   - a line `Reverts #N` / `Undoes #N` in the title or body exempts commits of PR #N,
 *   - the maintainer label `silent-revert-exempt` exempts all.
 * The CLI reads these LIVE from the PR (`--pr`) when the lane runs, not from the frozen
 * event payload: editing the PR re-judges it, and re-running the failed jobs after
 * labelling picks the label up. A bare mention of `revert` anywhere else declares nothing.
 */
export function parseDeclarations({ title = '', body = '', labels = [] } = {}) {
  const prs = new Set();
  for (const line of `${title}\n${body}`.split('\n')) {
    const m = /^\s*(?:reverts?|undoes)\b\s*:?\s*((?:#\d+[\s,]*(?:and\s+)?)+)/i.exec(line);
    if (m) for (const n of m[1].matchAll(/#(\d+)/g)) prs.add(Number(n[1]));
  }
  const byLabel = labels.includes(EXEMPT_LABEL);
  // Only the two shapes a revert is actually titled in: conventional `revert(scope): ...` /
  // `revert: ...`, and the `Revert "..."` GitHub and `git revert` write. A prose title that merely
  // starts with the word (`Revert button is broken`) is a UI fix and declares nothing.
  const byTitle = /^revert(\([^)]*\))?!?:/i.test(title.trim()) || /^revert "/i.test(title.trim());
  return { all: byLabel || byTitle, reason: byLabel ? `label ${EXEMPT_LABEL}` : byTitle ? 'a revert title' : null, prs };
}

/** Split findings into those the PR declared and those it did not. */
export function applyDeclarations(findings, declarations) {
  if (declarations.all) return { undeclared: [], declared: findings, reason: declarations.reason };
  const declared = findings.filter((f) => f.pr !== null && declarations.prs.has(f.pr));
  const undeclared = findings.filter((f) => !declared.includes(f));
  return { undeclared, declared, reason: declared.length ? 'a `Reverts #N` line' : null };
}

const SHOWN = 12;

export function formatFinding(f) {
  const who = f.pr === null ? f.sha.slice(0, 10) : `#${f.pr}`;
  const undone = f.restored.length + f.lifecycle.length;
  const lines = [
    `  ${who}  ${f.sha.slice(0, 10)}  ${f.subject}`,
    `    ${undone} of its ${f.touched} files are undone (${f.distance} commit${f.distance === 1 ? '' : 's'} back on the base): ` +
      `${f.restored.length} back to their exact pre-${who} bytes` +
      (f.lifecycle.length ? `, ${f.lifecycle.length} it created now deleted (not counted toward the threshold)` : ''),
  ];
  for (const { path, kind } of f.restored.slice(0, SHOWN)) lines.push(`      ${kind.padEnd(9)} ${path}`);
  if (f.restored.length > SHOWN) lines.push(`      ... and ${f.restored.length - SHOWN} more`);
  for (const path of f.lifecycle.slice(0, SHOWN)) lines.push(`      deleted   ${path}`);
  if (f.lifecycle.length > SHOWN) lines.push(`      ... and ${f.lifecycle.length - SHOWN} more deleted`);
  return lines.join('\n');
}

const quote = (p) => `'${p.replace(/'/g, "'\\''")}'`;
const list = (paths) => `${paths.slice(0, 5).map(quote).join(' ')}${paths.length > 5 ? ' ...' : ''}`;

/** Remedies drawn from what was found: a `re-added` path is absent on the base, so it is `git rm`, not a checkout. */
export function formatFailure(findings, base = 'origin/main') {
  const names = findings.map((f) => (f.pr === null ? f.sha.slice(0, 10) : `#${f.pr}`)).join(', ');
  const all = findings.flatMap((f) => [...f.restored, ...f.lifecycle.map((path) => ({ path, kind: 'deleted' }))]);
  const checkout = all.filter((r) => r.kind !== 're-added').map((r) => r.path);
  const remove = all.filter((r) => r.kind === 're-added').map((r) => r.path);
  const prs = [...new Set(findings.filter((f) => f.pr !== null).map((f) => f.pr))];
  const fix = [`  git diff ${base}...HEAD -- ${quote(all[0].path)}     # see what the PR does to a listed file`];
  if (checkout.length) fix.push(`  git checkout ${base} -- ${list(checkout)}     # take the base's version back`);
  if (remove.length) fix.push(`  git rm -- ${list(remove)}     # these are absent on the base; the PR brings them back`);
  return [
    `SILENT REVERT: merging this PR would undo already-merged work (${names}) without saying so.`,
    '',
    ...findings.map(formatFinding),
    '',
    'If the revert is a mistake (a stale working tree, a conflict resolved to the old side, a reset --soft',
    'onto a moved main), rebuild the branch from current main and re-apply only your own change:',
    ...fix,
    '',
    'If the revert is intended, declare it so it is not silent:',
    '  - title it `revert(scope): ...` or `Revert "..."`, or',
    prs.length
      ? `  - put a line \`Reverts ${prs.map((n) => `#${n}`).join(', ')}\` in the PR title or description, or`
      : '  - (a `Reverts #<PR>` line cannot name these commits: none carries a PR number), or',
    `  - have a maintainer (triage access or above) apply the \`${EXEMPT_LABEL}\` label.`,
    '  The declaration is read live when the lane runs: edit the PR, or re-run the failed jobs after labelling.',
  ].join('\n');
}
