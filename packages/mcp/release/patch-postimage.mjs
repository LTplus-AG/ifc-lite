/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createHash } from 'node:crypto';

/** Read the exact old and new sequences from each unified diff hunk. */
export function patchPostimages(patch) {
  const files = [];
  for (const diff of patch.replaceAll('\r\n', '\n').split(/^diff --git /m).slice(1)) {
    const [header, ...sections] = diff.split(/^@@ /m);
    const index = /^index ([a-f0-9]{7,40})\.\.[a-f0-9]+(?: |$)/m.exec(header);
    const before = /^--- (?:a\/(.+)|\/dev\/null)$/m.exec(header);
    const after = /^\+\+\+ (?:b\/(.+)|\/dev\/null)$/m.exec(header);
    if (!index || !before || !after || (!before[1] && !after[1]) || !sections.length) {
      throw new Error('Patch file lacks Git hunk or preimage metadata');
    }
    files.push({
      name: after[1] ?? before[1],
      deleted: !after[1],
      added: !before[1],
      preimage: index[1],
      hunks: sections.map(parseHunk),
    });
  }
  if (!files.length) throw new Error('Patch contains no Git file diffs');
  return files;
}

function parseHunk(section) {
  const [header, ...lines] = section.split('\n');
  const range = /^-\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
  if (!range) throw new Error('Invalid patch hunk range');
  const oldCount = Number(range[1] ?? 1);
  const newCount = Number(range[3] ?? 1);
  const start = Number(range[2]) - (newCount === 0 ? 0 : 1);
  const before = [];
  const after = [];
  let targets = [];
  for (const line of lines) {
    if (line === '\\ No newline at end of file') {
      for (const target of targets) target[target.length - 1] = target.at(-1).slice(0, -1);
      continue;
    }
    if (before.length === oldCount && after.length === newCount) break;
    targets = [];
    if (line[0] === ' ' || line[0] === '-') targets.push(before);
    if (line[0] === ' ' || line[0] === '+') targets.push(after);
    if (!targets.length) throw new Error('Invalid patch hunk line');
    for (const target of targets) target.push(line.slice(1) + '\n');
  }
  if (before.length !== oldCount || after.length !== newCount) throw new Error('Incomplete patch hunk');
  return { start, before, after };
}

function blobId(text) {
  return createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');
}

/**
 * Reverse exact hunks at their declared locations, without fuzz or relocation.
 * Checking the reconstructed original blob detects extra lines even at the end
 * of a zero-context hunk, while allowing identical lines elsewhere upstream.
 */
export function matchesPostimage(text, file) {
  for (const candidate of new Set([text, text.replaceAll('\r\n', '\n')])) {
    const lines = candidate.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    const original = [];
    let cursor = 0;
    for (const { start, before, after } of file.hunks) {
      if (start < cursor || start > lines.length || after.some((line, i) => lines[start + i] !== line)) {
        cursor = -1;
        break;
      }
      original.push(...lines.slice(cursor, start), ...before);
      cursor = start + after.length;
    }
    if (cursor < 0) continue;
    const reconstructed = original.join('') + lines.slice(cursor).join('');
    if (file.added ? reconstructed === '' : blobId(reconstructed).startsWith(file.preimage)) return true;
  }
  return false;
}
