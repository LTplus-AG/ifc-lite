/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { addedLineRanges } from './build-review-input.mjs';
import { isMainEntry } from '../lib/is-main-entry.mjs';

export function patchForRange(base, head, path, { exec = execFileSync } = {}) {
  const diff = exec('git', ['diff', '--no-ext-diff', '--unified=3', base, head, '--', path], { encoding: 'utf8' });
  const lines = diff.split('\n');
  const firstHunk = lines.findIndex((line) => line.startsWith('@@ '));
  if (firstHunk < 0) throw new Error(`${path} has no textual diff between ${base} and ${head}.`);
  return lines.slice(firstHunk).join('\n').replace(/\n$/, '');
}

export function refreshCase(casePath, base, head, options) {
  if (!/^[0-9a-f]{40}$/.test(base) || !/^[0-9a-f]{40}$/.test(head)) {
    throw new Error('Base and head must be exact 40-hex commit ids.');
  }
  const fixture = JSON.parse(readFileSync(casePath, 'utf8'));
  fixture.input.headSha = head;
  fixture.input.files = fixture.input.files.map((file) => {
    const patch = patchForRange(base, head, file.path, options);
    return { ...file, patch, addedLineRanges: addedLineRanges(patch) };
  });
  writeFileSync(casePath, `${JSON.stringify(fixture, null, 2)}\n`);
}

if (isMainEntry(import.meta.url)) {
  const [casePath, base, head] = process.argv.slice(2);
  if (!casePath || !base || !head) {
    throw new Error('Usage: node scripts/review/refresh-eval-case.mjs <case.json> <base-sha> <head-sha>');
  }
  refreshCase(casePath, base, head);
}
