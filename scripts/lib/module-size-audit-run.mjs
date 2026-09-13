/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Check mode's merge-base audit (#4388), the I/O half: resolve the base and
 * the changed-path set, read each allowlist as it was at the base, hand the
 * rows to `auditAgainstBase` and report. Lives beside the CLI rather than in
 * it because `scripts/check-module-size.mjs` is allowlisted and may not grow;
 * the rules are in `module-size-base-audit.mjs`, the git plumbing in
 * `module-size-git.mjs`.
 *
 * Two allowlists are audited: the TypeScript one this gate owns, and the
 * Rust twin's (`rust/processing/tests/module_size_allowlist.txt`), whose
 * cargo test has no git and whose digest pin only proves a row was edited,
 * not that the number is right. Only rowed paths are measured on the Rust
 * side, so there is no walk and no exemption rule there: a row for a file
 * that moved under `tests/` still measures, and the cargo test reports that
 * one as its own advisory note. The two allowlists also get different
 * remedies: `--update` rewrites only the TypeScript one, while the Rust rows
 * are edited by hand and their digest pin re-pinned from the cargo test's
 * own output -- printing the TypeScript command for a Rust row would send
 * the reader to a command that leaves the failing file untouched.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { countLines, parseAllowlist } from './module-size-ratchet.mjs';
import { changedFilesWarned, describeBase, readBlobAt, underCi } from './module-size-git.mjs';
import { auditAgainstBase, summarizeAudit } from './module-size-base-audit.mjs';

/** The Rust twin's allowlist, repo-relative. */
export const RUST_ALLOWLIST = 'rust/processing/tests/module_size_allowlist.txt';

// What to do about a failing row, per allowlist. Each failure line already
// says "delete it" or "restore it"; the remedy says how, and which tool (if
// any) writes the number. The two-sided diff comes first on purpose: a row
// is only "this change's" once the merge base says so.
const TS_REMEDY = `Then do what each line above says -- DELETE a row it says
needs no row, RESTORE a row it says was deleted -- for every file this change
did not touch (a scoped \`--update\` leaves those alone); rebase or merge main
so the count CI measures is the count you measure (CI judges the merge commit
against origin/main, so a row exact on a stale branch can carry headroom
there); then re-run \`pnpm lint:module-size-baseline\` (\`--allow-raise\` only
for growth this change justifies in the PR) for the rest and commit what it
writes (#4388).`;

const RUST_REMEDY = `This file has no update mode: do what each line above
says by hand -- set a row to the file's measured line count (\`wc -l\`, the
same count \`str::lines()\` gives), DELETE a row it says needs no row, RESTORE
a row it says was deleted -- then re-pin ALLOWLIST_DIGESTS in
rust/processing/tests/module_size_ratchet.rs: \`cargo test -p
ifc-lite-processing --test module_size_ratchet\` prints the new figures
(#4388).`;

/**
 * Run both audits. `headRows` is the parsed TS allowlist, `measured` a
 * `Map<rel, lines>` of every non-exempt module the walk saw. Returns
 * `{ failed, tsAudit, scope }`: `failed` when any row a measurement does not
 * justify was found (or the audit could not run under CI); `tsAudit` is the
 * TS allowlist's `auditAgainstBase` result, or `null` when it did not run;
 * `scope` is `changedFiles()`'s answer, or `{ error }`.
 */
export function runMergeBaseAudits({ root, allowlistPath, headRows, measured, baseRef }) {
  const state = { failed: false, tsAudit: null, scope: null };

  // The audit could not run. Under CI that is a failure: a run that cannot see
  // the base cannot tell a resolved conflict from a measured row, and "skipped"
  // would print the same OK line as "judged" — the shape every gate in this
  // family exists to avoid. Elsewhere it is a loud skip naming what was skipped.
  const unavailable = (why) => {
    if (underCi()) {
      state.failed = true;
      console.error(`
check-module-size: the merge-base audit could not run: ${why}.

CI is set, so this is a failure, not a skip (#4388). Check out with full history
and an origin/main ref, or pass --base <ref> to name the base by hand.
`);
    } else {
      console.warn(
        `check-module-size: WARNING -- merge-base audit SKIPPED: ${why}. Allowlist rows were ` +
          `NOT judged against the merge base this run (#4388); fetch origin/main or pass --base <ref>.`,
      );
    }
    return null;
  };

  const scope = changedFilesWarned(root, baseRef);
  state.scope = scope;
  if (scope.error !== undefined) {
    unavailable(scope.error);
    return state;
  }
  const sha9 = scope.base.sha.slice(0, 9);

  // The same path as it was at the merge base. Consulted only for a kept row
  // whose file this change touched and which is now under the limit or gone
  // (a handful of blobs at most), to tell this change's shrink from a stale
  // row main already carried.
  const measureAtBase = (rel) => {
    const text = readBlobAt(root, scope.base.sha, rel);
    return text === null ? null : countLines(text);
  };

  // Audit one allowlist (`rel`, repo-relative) whose HEAD rows are `rows`;
  // `remedy` is that allowlist's own after-the-diff instruction.
  const auditOne = (rel, rows, measure, remedy) => {
    const baseText = readBlobAt(root, scope.base.sha, rel);
    if (baseText === null) return unavailable(`${rel} is not readable at merge-base ${sha9}`);
    let baseRows;
    try {
      baseRows = parseAllowlist(baseText, `${rel}@${sha9}`);
    } catch (err) {
      return unavailable(err.message);
    }
    const audit = auditAgainstBase({ baseRows, headRows: rows, measure, measureAtBase, changed: scope.changed });
    console.log(`check-module-size: ${rel} vs merge-base ${describeBase(scope.base)}: ${summarizeAudit(audit)}`);
    if (audit.failures.length > 0) {
      state.failed = true;
      console.error(`
Allowlist row(s) in ${rel} that this change wrote or kept, and that the
measurement does not justify (vs merge-base ${describeBase(scope.base)}):\n
${audit.failures.join('\n')}

A row that differs from the merge base is this change's row, and the only
number it may carry is the file's measured line count. After a merge
conflict, never resolve by picking a side -- diff BOTH sides against the
merge base. ${remedy}
`);
    }
    return audit;
  };

  // The TS allowlist: judged against the walk's own measurement. The path must
  // be inside the worktree, or there is no base-side blob to read.
  let allowlistReal = null;
  try {
    allowlistReal = realpathSync.native(allowlistPath);
  } catch {
    allowlistReal = null;
  }
  const allowlistRel = allowlistReal === null ? null : relative(scope.top, allowlistReal).split('\\').join('/');
  if (allowlistRel === null || allowlistRel.startsWith('..') || isAbsolute(allowlistRel)) {
    unavailable(`allowlist ${allowlistPath} is not inside the worktree ${scope.top}`);
  } else {
    state.tsAudit = auditOne(allowlistRel, headRows, (rel) => measured.get(rel) ?? null, TS_REMEDY);
  }

  // The Rust allowlist, when the tree has one.
  const rustHead = join(root, RUST_ALLOWLIST);
  if (!existsSync(rustHead)) {
    console.log(`check-module-size: no ${RUST_ALLOWLIST} under ${root}; the Rust allowlist was not audited`);
    return state;
  }
  let rustRows;
  try {
    rustRows = parseAllowlist(readFileSync(rustHead, 'utf8'), RUST_ALLOWLIST);
  } catch (err) {
    // The HEAD file is this change's, so a duplicate row -- the classic
    // conflict residue -- is a failure here, not an unavailable audit.
    state.failed = true;
    console.error(`check-module-size: ${err.message}`);
    return state;
  }
  const measureRust = (rel) => {
    try {
      return countLines(readFileSync(join(root, rel), 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      // An unreadable file must not pass as "no file": null is the one answer
      // that makes a deleted row look justified.
      throw new Error(`cannot read ${rel}: ${err.message}`);
    }
  };
  auditOne(RUST_ALLOWLIST, rustRows, measureRust, RUST_REMEDY);
  return state;
}
