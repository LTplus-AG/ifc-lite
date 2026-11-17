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
  // ` #` starts a comment after a block indicator or in a plain scalar; a
  // quoted scalar keeps it, and GitHub expressions never contain one anyway.
  const line = lines[at].replace(/^ {4}if:/, '').trim();
  const head = /^['"]/.test(line) ? line : line.replace(/(?:^|\s+)#.*$/, '');
  const rest = [];
  for (const raw of lines.slice(at + 1)) {
    if (raw.trim() === '') continue;
    if (!/^ {5,}\S/.test(raw)) break; // a sibling key ends the scalar
    rest.push(raw.trim());
  }
  const unreadable = (why) => new Error(`job ${jobId}: cannot read \`if: ${head}\` (${why})`);
  if (/^[>|](?:[1-9]?[-+]?|[-+][1-9])$/.test(head) || head === '') {
    if (rest.length === 0) throw unreadable('empty block scalar');
    return rest.join(' ');
  }
  const text = [head, ...rest].join(' ');
  if (head.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(text)) throw unreadable('unterminated single-quoted scalar');
    return text.slice(1, -1).replaceAll("''", "'");
  }
  if (head.startsWith('"')) {
    // Escapes other than \" and \\ cannot appear in a sane condition; refuse them.
    if (!/^"(?:[^"\\]|\\["\\])*"$/.test(text)) throw unreadable('unsupported double-quoted scalar');
    return text.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  if (/^[&*!%@`]/.test(head)) throw unreadable('anchor, alias, tag or reserved indicator');
  return text;
}
