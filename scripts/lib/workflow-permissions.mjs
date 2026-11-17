/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

const indentOf = (line) => line.length - line.trimStart().length;

/**
 * Every `permissions:` block in `text` as { indent, scopes: { scope: level } },
 * read line by line because the guard runs before `pnpm install` (no yaml).
 * Lines inside a `|`/`>` block scalar (a `run:` script) are skipped. Only the
 * block-mapping form and `{}` are judged; `write-all`, a flow mapping, a
 * `permissions` key inside a flow mapping or an entry it cannot read is
 * reported to `out`, so a grant check fails closed on what it did not read.
 */
export function permissionBlocks(text, out, file) {
  const lines = text.split('\n');
  const blocks = [];
  let scalarIndent = -1;
  for (const [i, line] of lines.entries()) {
    if (scalarIndent >= 0) {
      if (line.trim() === '' || indentOf(line) > scalarIndent) continue;
      scalarIndent = -1;
    }
    if (/:\s*[|>][-+0-9]*\s*(?:#.*)?$/.test(line)) scalarIndent = indentOf(line);
    const head = line.match(/^( *)(?:- +)?["']?permissions["']?\s*:\s*(.*?)\s*(?:#.*)?$/);
    if (!head) {
      if (/[{,]\s*["']?permissions["']?\s*:/.test(line)) out.push(`${file}: cannot judge \`${line.trim()}\`; spell permissions out as a block`);
      continue;
    }
    const indent = head[1].length;
    if (head[2] === '{}') {
      blocks.push({ indent, scopes: {} });
      continue;
    }
    if (head[2] !== '') {
      out.push(`${file}: cannot judge \`permissions: ${head[2]}\`; spell each scope out`);
      continue;
    }
    const scopes = {};
    for (let j = i + 1; j < lines.length; j += 1) {
      const entry = lines[j];
      if (entry.trim() === '' || entry.trim().startsWith('#')) continue;
      if (indentOf(entry) <= indent) break;
      const m = entry.match(/^ +["']?([a-z-]+)["']?\s*:\s*["']?(read|write|none)["']?\s*(?:#.*)?$/);
      if (!m) {
        out.push(`${file}: cannot judge permissions entry \`${entry.trim()}\``);
        break;
      }
      scopes[m[1]] = m[2];
    }
    blocks.push({ indent, scopes });
  }
  return blocks;
}
