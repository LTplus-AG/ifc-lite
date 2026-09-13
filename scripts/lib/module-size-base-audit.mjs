/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The merge-base audit of a module-size allowlist (#4388): which rows THIS
 * change edited relative to the base, and whether the file each of them
 * describes justifies the number it now carries.
 *
 * WHY THIS EXISTS: the gate's two teeth (a new god file, a listed file over
 * its budget) both judge a FILE against a ROW. Neither judges the row. So a
 * conflict resolution in the allowlist that resurrected a deleted row for a
 * 268-line file, kept the row of a file a split had taken to 348 lines, and
 * carried a 766 budget for a 765-line file printed three `note:` lines and
 * `OK` (#4330, described in #4388). The information was present and nothing
 * acted on it, because the shrink/slack notes are advisory by design: a
 * shrink landing in ANOTHER PR must not turn this one red.
 *
 * The merge base is what separates the two. A row that differs from its
 * base-side twin was written by this change (or by its conflict resolution),
 * and `--update` writes exactly the measured count, so the discipline is
 * already "the row equals the measurement" -- this makes the gate say so for
 * a row ADDED or RAISED. A row LOWERED with slack left is held only to "the
 * file is still over the limit": lowering cannot loosen the ratchet, and
 * failing it on headroom would redden the branch whose file main shrank a
 * little further while the PR sat in review -- the one shape the advisory
 * notes exist to keep green. A row that is byte-identical to the base was
 * written by someone else, and stays advisory UNLESS this change also
 * touched the file AND the file was over the limit at the base: then the
 * shrink is this change's, and keeping the old budget is the re-growth
 * headroom the split PR in #4388 left behind. (A row main already carried
 * for a file under the limit is main's stale row, whoever edits the file
 * next; the `shrunk` note reports it, and a scoped `--update` drops it.)
 *
 * Pure: takes parsed rows, two measurement functions and the changed-path
 * set, returns strings. The CLI resolves the base and reads the blobs.
 */

import { LIMIT } from './module-size-ratchet.mjs';

/**
 * @param {object} input
 * @param {Map<string, number>} input.baseRows   rows at the merge base
 * @param {Map<string, number>} input.headRows   rows in the working tree
 * @param {(rel: string) => number | null} input.measure  line count of a
 *        module at HEAD, or null when it was not measured (gone, renamed or
 *        exempt)
 * @param {(rel: string) => number | null} input.measureAtBase  line count
 *        of the same path at the merge base, or null when it had none there.
 *        Consulted only for a kept row whose file this change touched and
 *        which now measures under the limit or not at all: it decides whether
 *        the shrink is this change's (the file was over the limit at the
 *        base) or main's stale row.
 * @param {Set<string>} input.changed   repo-relative paths this change
 *        touched, from `changedFiles()`
 * @returns {{ added: string[], raised: string[], lowered: string[],
 *             deleted: string[], kept: number, failures: string[] }}
 *   The four lists name the rows that differ from the base (for the log,
 *   so the resolution is visible on every run); `failures` are the rows a
 *   measurement does not justify, each a `  <path>: <why>` line.
 */
export function auditAgainstBase({ baseRows, headRows, measure, measureAtBase, changed }) {
  const added = [];
  const raised = [];
  const lowered = [];
  const deleted = [];
  const failures = [];
  let kept = 0;

  for (const [rel, budget] of headRows) {
    const before = baseRows.get(rel);
    const lines = measure(rel);
    let edit = null;
    let loosened = false;
    if (before === undefined) {
      edit = `added at ${budget}`;
      loosened = true;
      added.push(`  ${rel}: ${edit}`);
    } else if (budget > before) {
      edit = `raised ${before} -> ${budget}`;
      loosened = true;
      raised.push(`  ${rel}: ${edit}`);
    } else if (budget < before) {
      edit = `lowered ${before} -> ${budget}`;
      lowered.push(`  ${rel}: ${edit}`);
    } else {
      kept += 1;
    }

    if (edit !== null) {
      // A row this change wrote. It must describe a file that is there and
      // over the limit, whichever way it was edited: a resurrected row for a
      // 268-line file is the #4330 case however the number compares.
      if (lines === null) {
        failures.push(
          `  ${rel}: row ${edit}, but no such module was measured (gone, renamed or exempt); delete the row`,
        );
      } else if (lines <= LIMIT) {
        failures.push(
          `  ${rel}: row ${edit}, but the file measures ${lines} <= ${LIMIT} and needs no row; delete it`,
        );
      } else if (loosened && lines < budget) {
        // Added or raised above the file: annexed headroom (the 766-for-765
        // case). `--update` writes the measured count, so anything above it
        // is a hand-picked number. A LOWERED row with slack is not held to
        // this: it loosened nothing, and main shrinking the file a little
        // further while the branch sat in review must stay a note (the
        // pull_request merge commit is measured against the branch's row).
        // It IS still failed, by the two branches above, when main's shrink
        // took the file under the limit or removed it: that row is stale,
        // and the same rebase + `--update` drops it.
        failures.push(
          `  ${rel}: row ${edit}, but the file measures ${lines}: ${budget - lines} line(s) of headroom ` +
            `the file does not have; re-run --update so the row says what the file says`,
        );
      }
      // lines > budget is growth past the budget, and the existing `grew`
      // tooth (Rust: the cargo test) already fails it with its own message.
      continue;
    }

    // Kept byte-for-byte from the base: somebody else's row, UNLESS this
    // change touched the file AND the file was over the limit at the base.
    // Then the shrink (or the delete) is this change's, and the row it left
    // behind is exactly what #4388's split PR lost in its conflict
    // resolution. A file already under the limit at the base means main was
    // carrying a stale row before this change existed; that is the `shrunk`
    // note's job, and blaming it on whoever edits the file next would send
    // them to a conflict resolution that never happened.
    if (!changed.has(rel)) continue;
    if (lines !== null && lines > LIMIT) continue;
    const atBase = measureAtBase(rel);
    if (atBase === null || atBase <= LIMIT) continue;
    if (lines === null) {
      failures.push(
        `  ${rel}: this change removed or renamed the file (${atBase} lines at the merge base) but kept ` +
          `its row (budget ${budget}); delete the row`,
      );
    } else {
      failures.push(
        `  ${rel}: this change took the file from ${atBase} to ${lines} <= ${LIMIT} but kept its row ` +
          `(budget ${budget}); delete the row`,
      );
    }
  }

  for (const [rel, before] of baseRows) {
    if (headRows.has(rel)) continue;
    deleted.push(`  ${rel}: deleted (was ${before})`);
    const lines = measure(rel);
    // On the TS side this is also a `newOffenders` failure; the point of
    // saying it here too is the WHY: the row went missing relative to the
    // merge base, which after a conflict means somebody's deletion was
    // taken for the other side's addition (#4388 has the worked example).
    if (lines !== null && lines > LIMIT) {
      failures.push(
        `  ${rel}: row (budget ${before}) deleted relative to the merge base, but the file measures ` +
          `${lines} > ${LIMIT}; restore it -- was the deletion main's or this change's?`,
      );
    }
  }

  for (const list of [added, raised, lowered, deleted, failures]) list.sort();
  return { added, raised, lowered, deleted, kept, failures };
}

/** `+A added, ^R raised, vL lowered, -D deleted` — zero counts included. */
export function summarizeAudit({ added, raised, lowered, deleted }) {
  return `+${added.length} added, ^${raised.length} raised, v${lowered.length} lowered, -${deleted.length} deleted`;
}

/** The compact form the OK line carries: `+A ^R vL -D`. */
export function compactAudit({ added, raised, lowered, deleted }) {
  return `+${added.length} ^${raised.length} v${lowered.length} -${deleted.length}`;
}
