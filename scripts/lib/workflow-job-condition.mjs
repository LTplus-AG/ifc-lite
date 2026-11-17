/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A job's whole `if:` expression, or `null` when the job has none.
 *
 * test.yml writes long conditions as `>-` block scalars, and the terms that
 * path-gate a job usually sit on the second line or later. Reading only the
 * key's own line returned `>-`, which names no filter, so the job read as
 * "runs on every path" (`revert-oracle` did, and its unreachable inputs went
 * unreported). Handled: block scalars (`>`, `|`, with chomping and indentation
 * indicators), plain scalars continued on deeper-indented lines, and quoted
 * scalars. Line folding does not matter here: the callers match terms with
 * `\s*` between tokens, so lines are joined with a space.
 *
 * FAILS CLOSED. An `if:` it cannot read throws: returning `null` or a partial
 * expression would claim the job runs on more paths than it does.
 */
export function jobCondition(jobText, jobId = '(unnamed)') {
  const lines = jobText.split('\n');
  const at = lines.findIndex((l) => /^ {4}if:/.test(l));
  if (at === -1) return null;
  const rest = [];
  for (const raw of lines.slice(at + 1)) {
    if (raw.trim() === '') continue;
    if (!/^ {5,}\S/.test(raw)) break; // a sibling key ends the scalar
    rest.push(raw.trim());
  }
  const first = lines[at].replace(/^ {4}if:/, '').trim().replace(/^#.*$/, '');
  const unreadable = (why) => new Error(`job ${jobId}: cannot read \`if: ${first}\` (${why})`);
  // A block scalar's body is content, `#` included.
  if (/^[>|](?:[1-9]?[-+]?|[-+][1-9])(?:\s+#.*)?$/.test(first)) {
    if (rest.length === 0) throw unreadable('empty block scalar');
    return rest.join(' ');
  }
  // Flow scalars may start on the next line; ` #` after the value is a comment.
  const parts = [first, ...rest].filter(Boolean);
  if (parts.length === 0) throw unreadable('empty scalar');
  const text = parts.join(' ');
  const single = text.match(/^'((?:[^']|'')*)'(?:\s+#.*)?$/);
  if (single) return single[1].replaceAll("''", "'");
  // Escapes other than \" and \\ cannot appear in a sane condition; refuse them.
  const double = text.match(/^"((?:[^"\\]|\\["\\])*)"(?:\s+#.*)?$/);
  if (double) return double[1].replace(/\\(["\\])/g, '$1');
  if (/^['"]/.test(text)) throw unreadable('unterminated or unsupported quoted scalar');
  if (/^[&*!%@`]/.test(text)) throw unreadable('anchor, alias, tag or reserved indicator');
  // A comment ends a plain scalar; one before its last line is not something to guess past.
  const cut = parts.findIndex((l) => /\s#/.test(l));
  if (cut !== -1 && cut < parts.length - 1) throw unreadable('comment inside a plain scalar');
  return parts.join(' ').replace(/\s+#.*$/, '');
}
