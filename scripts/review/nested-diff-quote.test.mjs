/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5563: an evidence PR commits a unified patch as a file without applying it.
 * Every line of that file's PR patch then carries two markers, the PR diff's
 * and the archived diff's, and a reviewer that quotes the source line it read
 * quotes it without the inner one. The validator refused that quote as
 * PROOF_OF_WORK_FAILED on both attempts of PR #5558's review.
 *
 * The archive below is the shape of #5558's
 * `docs/architecture/evidence/viewer-ancestor-screen-5555/renderer-ablation.patch`.
 * Run through the validator as a process, the way the workflow runs it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SENTINEL, addedLinesMatching, quoteAppearsIn } from './validate-findings.mjs';
import { addedLineRanges } from './build-review-input.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'validate-findings.mjs');
const TMP = mkdtempSync(join(tmpdir(), 'nested-diff-quote-'));
let seq = 0;

const SOURCE_LINE = '    if (!this.ephemeralStreamingMode && this.streamingFragments.length > 0) return;';
const COMMENT_LINE = '    // DIAGNOSTIC ONLY: skip the ancestor screen while streaming.';
const REMOVED_LINE = '    this.screenAncestors(fragment);';

// The archived patch as the FILE holds it: its own headers, hunk and markers.
const ARCHIVE = [
  'diff --git a/packages/renderer/src/index.ts b/packages/renderer/src/index.ts',
  '--- a/packages/renderer/src/index.ts',
  '+++ b/packages/renderer/src/index.ts',
  '@@ -40,3 +40,4 @@',
  ' function screen(fragment) {',
  `+${COMMENT_LINE}`,
  `+${SOURCE_LINE}`,
  `-${REMOVED_LINE}`,
  ' }',
];
// ...and as the PR diff that ADDS that file shows it: one more `+` on each line.
const PATCH = [`@@ -0,0 +1,${ARCHIVE.length} @@`, ...ARCHIVE.map((l) => `+${l}`)].join('\n');
const PATH = 'docs/architecture/evidence/viewer-ancestor-screen-5555/renderer-ablation.patch';
// The same added lines, in a file whose format is NOT a diff: no inner marker exists to strip.
const TS_PATH = 'packages/x/plus-prefixed.ts';

const INPUT = {
  headSha: 'b'.repeat(40),
  files: [
    { path: PATH, patch: PATCH, addedLineRanges: addedLineRanges(PATCH) },
    { path: TS_PATH, patch: PATCH, addedLineRanges: addedLineRanges(PATCH) },
  ],
  unreviewable: [],
};

// New-file line numbers inside the archive: line 6 is COMMENT_LINE, 7 is SOURCE_LINE.
const SOURCE_AT = 7;

const response = ({ path = PATH, quoted = SOURCE_LINE, findingQuote = SOURCE_LINE, line = SOURCE_AT } = {}) => ({
  verdict: 'findings',
  files_reviewed: [PATH, TS_PATH],
  riskiest_change: { path, quoted_line: quoted },
  findings: [
    {
      path,
      line,
      quote: findingQuote,
      body: 'This early return skips the ancestor screen for every streamed fragment.',
      class: 'correctness',
    },
  ],
  end: SENTINEL,
});

function run(raw) {
  const n = (seq += 1);
  const rawPath = join(TMP, `raw-${n}.json`);
  const inputPath = join(TMP, `input-${n}.json`);
  const outPath = join(TMP, `findings-${n}.json`);
  writeFileSync(rawPath, JSON.stringify(raw));
  writeFileSync(inputPath, JSON.stringify(INPUT));
  const r = spawnSync(process.execPath, [SCRIPT, '--raw', rawPath, '--input', inputPath, '--out', outPath], {
    encoding: 'utf8',
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test('#5563 GREEN: a source line inside an archived patch, quoted without its inner `+`, is proof of work', () => {
  const r = run(response());
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /VALIDATED: verdict=findings, 1 finding/);
});

test('#5563: the retry shape too -- the archived comment line, quoted without its inner `+`', () => {
  const r = run(response({ quoted: COMMENT_LINE, findingQuote: COMMENT_LINE, line: SOURCE_AT - 1 }));
  assert.equal(r.code, 0, r.out);
});

test('#5563: the archived line quoted WITH its inner marker still passes, as it did before', () => {
  const r = run(response({ quoted: `+${SOURCE_LINE}`, findingQuote: `+${SOURCE_LINE}` }));
  assert.equal(r.code, 0, r.out);
});

test('#5563 CONTROL: a line that is not in the archive still fails proof of work', () => {
  const r = run(response({ quoted: '    if (this.streamingFragments.length > 0) return;' }));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /PROOF_OF_WORK_FAILED/);
});

test('#5563 CONTROL: a FRAGMENT of an archived line is still not a line', () => {
  assert.equal(quoteAppearsIn(PATCH, 'if (!this.ephemeralStreamingMode', 8, { path: PATH }), false);
  const r = run(response({ quoted: 'if (!this.ephemeralStreamingMode' }));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /PROOF_OF_WORK_FAILED/);
});

test('#5563 CONTROL: outside a .patch/.diff file no inner marker is stripped', () => {
  // A `.ts` line that happens to start with `+` is code, not an inner diff
  // marker, so the unprefixed text is a fragment of it and stays refused.
  assert.equal(quoteAppearsIn(PATCH, SOURCE_LINE, 8, { path: TS_PATH }), false);
  assert.equal(quoteAppearsIn(PATCH, SOURCE_LINE, 8), false, 'no path given: unchanged behaviour');
  const r = run(response({ path: TS_PATH }));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /PROOF_OF_WORK_FAILED/);
});

test('#5563: the per-finding anchor accepts the same quote the proof of work does, at its real line', () => {
  assert.deepEqual(addedLinesMatching(PATCH, SOURCE_LINE, { path: PATH }), [SOURCE_AT]);
  assert.deepEqual(addedLinesMatching(PATCH, SOURCE_LINE, { path: TS_PATH }), []);
  // The archive's removed line is part of what the archive documents, too.
  assert.equal(quoteAppearsIn(PATCH, REMOVED_LINE, 8, { path: PATH }), true);
  // Its own hunk header is never turned into anything but itself.
  assert.equal(quoteAppearsIn(PATCH, '-40,3 +40,4 @@', 8, { path: PATH }), false);
});
