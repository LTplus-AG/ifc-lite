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
const BLOCK = /^[>|](?:[1-9]?[-+]?|[-+][1-9])(?:\s+#.*)?$/;
const indent = (l) => l.length - l.trimStart().length;

export function jobCondition(jobText, jobId = '(unnamed)') {
  const lines = jobText.split('\n');
  const at = lines.findIndex((l) => /^ {4}if:/.test(l));
  if (at === -1) return null;
  const body = [];
  for (const raw of lines.slice(at + 1)) {
    if (raw.trim() === '') continue;
    if (!/^ {5,}\S/.test(raw)) break; // a sibling key ends the scalar
    body.push(raw);
  }
  const unreadable = (why) => new Error(`job ${jobId}: cannot read \`${lines[at].trim()}\` (${why})`);
  let first = lines[at].replace(/^ {4}if:/, '').trim().replace(/^#.*$/, '');
  if (first === '' && BLOCK.test(body[0]?.trim() ?? '')) first = body.shift().trim();
  // A block scalar's body is content, `#` included; a line less indented than
  // its first is a YAML error, not something to fold in.
  if (BLOCK.test(first)) {
    if (body.length === 0) throw unreadable('empty block scalar');
    if (body.some((l) => indent(l) < indent(body[0]))) throw unreadable('block scalar line under-indented');
    return body.map((l) => l.trim()).join(' ');
  }
  // Flow scalars may start on the next line; ` #` after the value is a comment.
  const parts = [first, ...body.map((l) => l.trim())].filter(Boolean);
  if (parts.length === 0) throw unreadable('empty scalar');
  const text = parts.join(' ');
  const lastHas = (comment) => !comment || parts.at(-1).endsWith(comment.trim());
  const single = text.match(/^'((?:[^']|'')*)'(\s+#.*)?$/);
  if (single && lastHas(single[2])) return single[1].replaceAll("''", "'");
  // Escapes other than \" and \\ cannot appear in a sane condition; refuse them.
  const double = text.match(/^"((?:[^"\\]|\\["\\])*)"(\s+#.*)?$/);
  if (double && lastHas(double[2])) return double[1].replace(/\\(["\\])/g, '$1');
  if (/^['"]/.test(text)) throw unreadable('unterminated or unsupported quoted scalar');
  // Not a string expression: a flow collection, null, an anchor, alias, tag or reserved indicator.
  if (/^[[{&*!%@`]/.test(text) || /^(?:~|null|Null|NULL)$/.test(text)) throw unreadable('not a plain string');
  // A comment ends a plain scalar; one before its last line is not something to guess past.
  const cut = parts.findIndex((l) => /(?:^|\s)#/.test(l));
  if (cut !== -1 && cut < parts.length - 1) throw unreadable('comment inside a plain scalar');
  const plain = text.replace(/\s+#.*$/, '');
  if (/:\s|:$/.test(plain)) throw unreadable('`: ` in a plain scalar is a mapping');
  return plain;
}
