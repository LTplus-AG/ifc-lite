/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const indentOf = (line) => line.length - line.trimStart().length;
// The line without a comment: a `#` at the start or after whitespace.
const code = (line) => line.replace(/(^|\s)#.*$/, '').trimEnd();
// An anchor or tag before a key (`&p permissions:`, `!!str permissions:`).
const PROPS = String.raw`(?:[&!]\S*\s+)*`;
const HEAD = new RegExp(String.raw`^( *)(?:- +)?${PROPS}["']?permissions["']?\s*:\s*(.*)$`);
// The key written another way: inside a flow mapping, or as an explicit `? key`.
const OTHER_KEY = /[{,]\s*["']?permissions["']?\s*:|^\s*(?:-\s+)?\?\s*["']?permissions\b/;
// A local reusable workflow call, quoted or not.
const USES = /^\s*(?:-\s+)?uses:\s*["']?\.\/(\.github\/workflows\/[^\s"'#]+\.ya?ml)["']?$/;

/**
 * Every `permissions:` block in `text` as { indent, scopes: { scope: level } },
 * read line by line because the guard runs before `pnpm install` (no yaml).
 * Lines inside a `|`/`>` block scalar (a `run:` script) are skipped. Only the
 * block-mapping form and `{}` are judged; `write-all`, a flow mapping, a
 * `permissions` key written any other way or an entry it cannot read is
 * reported to `out`, so a grant check fails closed on what it did not read.
 * The tests hold it to a YAML parser on every workflow in the repo.
 */
export function permissionBlocks(text, out, file) {
  return scan(text, out, file).blocks;
}

/** The blocks, plus the local reusable workflows `text` calls (outside scripts). */
function scan(text, out, file) {
  const lines = text.split('\n');
  const blocks = [];
  const calls = [];
  let scalarIndent = -1;
  for (const [i, raw] of lines.entries()) {
    const line = code(raw);
    if (scalarIndent >= 0) {
      if (raw.trim() === '' || indentOf(raw) > scalarIndent) continue;
      scalarIndent = -1;
    }
    if (line.trim() === '') continue;
    if (new RegExp(String.raw`(?::|^\s*-)\s*${PROPS}[|>][-+0-9]*$`).test(line)) scalarIndent = indentOf(line);
    const call = line.match(USES);
    if (call) calls.push(call[1]);
    const head = line.match(HEAD);
    if (!head) {
      if (OTHER_KEY.test(line)) out.push(`${file}: cannot judge \`${line.trim()}\`; spell permissions out as a block`);
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
      const entry = code(lines[j]);
      if (entry.trim() === '') continue;
      if (indentOf(entry) <= indent) break;
      const m = entry.match(/^ +["']?([a-z-]+)["']?\s*:\s*["']?(read|write|none)["']?$/);
      if (!m) {
        out.push(`${file}: cannot judge permissions entry \`${entry.trim()}\``);
        break;
      }
      scopes[m[1]] = m[2];
    }
    blocks.push({ indent, scopes });
  }
  return { blocks, calls };
}

/**
 * The scopes a call of `file` must grant: its own blocks and, all the way
 * down, those of each local reusable workflow it calls, since GitHub checks
 * every one when the run starts. An unreadable file is reported to `out`.
 */
export function workflowAsks(root, file, out, text = null, seen = new Set()) {
  if (seen.has(file)) return [];
  seen.add(file);
  const path = join(root, file);
  if (text === null && !existsSync(path)) {
    out.push(`cannot read ${file}, a workflow the call reaches; its permissions go unjudged`);
    return [];
  }
  const { blocks, calls } = scan(text ?? readFileSync(path, 'utf8'), out, file);
  return [...blocks, ...calls.flatMap((f) => workflowAsks(root, f, out, null, seen))];
}
