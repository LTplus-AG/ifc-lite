/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Every `permissions:` block in `text`, at any indent, as { scope: level }.
 * Only the block-mapping form is judged; `write-all`, a flow mapping or an
 * entry it cannot read is reported to `out`, so the caller's grant check fails
 * closed instead of passing over what it did not read.
 */
export function permissionBlocks(text, out, file) {
  const lines = text.split('\n');
  const blocks = [];
  lines.forEach((line, i) => {
    const head = line.match(/^( *)permissions:\s*(.*?)\s*(?:#.*)?$/);
    if (!head) return;
    if (head[2] !== '') return void out.push(`${file}: cannot judge \`permissions: ${head[2]}\`; spell each scope out`);
    const block = {};
    for (const entry of lines.slice(i + 1)) {
      if (entry.trim() === '' || entry.trim().startsWith('#')) continue;
      if (entry.length - entry.trimStart().length <= head[1].length) break;
      const m = entry.match(/^ +([a-z-]+): (read|write|none)\s*(?:#.*)?$/);
      if (!m) {
        out.push(`${file}: cannot judge permissions entry \`${entry.trim()}\``);
        break;
      }
      block[m[1]] = m[2];
    }
    blocks.push(block);
  });
  return blocks;
}
