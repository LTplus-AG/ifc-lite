#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression test for check-doc-samples.mjs reporting a clean typecheck over
 * snippets no compiler ever looked at (#3200).
 *
 * The defect: `spawnSync`'s result was read for its TEXT only. Neither
 * `res.error` nor `res.status` was looked at, and failures were recovered from
 * the output by two regexes, so anything tsc said that matched neither was
 * discarded and zero recovered failures printed as success. Measured on the
 * real repo with a deliberately broken snippet in README.md and
 * `node_modules/.bin/tsc` removed:
 *
 *   Doc code samples typecheck clean (262 snippets across 41 docs, 5 skipped).
 *   EXIT=0
 *
 * and again with a `tsc` that printed `error TS5083: Cannot read file
 * tsconfig.json.` and exited 2 - the shape of a real TS5083/TS6053/TS18003 or
 * an OOM'd compiler. Both are exit 0 with a tick.
 *
 * The gate derives ROOT from its own location, so a copy of it in a synthetic
 * tree is the whole reproduction: a README with one snippet, the two ambient
 * .d.ts files it copies, empty docs/guide, docs/tutorials and packages
 * directories, and a `node_modules/.bin/tsc` this test controls completely.
 * That last part is the point - the cases below differ ONLY in what the
 * compiler does, never in what the docs say.
 *
 * Run: node --test scripts/docs/check-doc-samples.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The one snippet every tree below carries, so `checked.length` is 1. */
const README = ['# Sample', '', '```ts', 'const n: number = 1;', '```', ''].join('\n');

/**
 * A tree holding the gate, its ambient support files, one doc with one
 * snippet, and `node_modules/.bin/tsc` written from `tscShim` (pass `null` to
 * leave the binary out entirely).
 */
function makeTree(tscShim, { readme = README } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'doc-samples-'));
  mkdirSync(join(root, 'scripts', 'docs'), { recursive: true });
  mkdirSync(join(root, 'docs', 'guide'), { recursive: true });
  mkdirSync(join(root, 'docs', 'tutorials'), { recursive: true });
  mkdirSync(join(root, 'packages'), { recursive: true });
  mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });

  for (const f of [
    'check-doc-samples.mjs',
    'doc-samples-globals.d.ts',
    'doc-samples-externals.d.ts',
  ]) {
    copyFileSync(join(HERE, f), join(root, 'scripts', 'docs', f));
  }
  writeFileSync(join(root, 'README.md'), readme, 'utf8');

  if (tscShim !== null) {
    const bin = join(root, 'node_modules', '.bin', 'tsc');
    writeFileSync(bin, tscShim, 'utf8');
    chmodSync(bin, 0o755);
  }
  return root;
}

function run(root) {
  const res = spawnSync(process.execPath, [join(root, 'scripts', 'docs', 'check-doc-samples.mjs')], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return { status: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

/**
 * A tsc that behaves: it echoes the program's files the way `--listFiles`
 * does, then prints whatever `extraLines` says, then exits `status`.
 *
 * It reads the file list out of the generated tsconfig rather than guessing,
 * so a change to how the gate names its temp files cannot make this shim
 * accidentally agree with it. `__TMP__` in a line stands for the program dir.
 */
function workingTsc({ extraLines = [], status = 0 } = {}) {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const i = process.argv.indexOf('-p');
const cfg = JSON.parse(fs.readFileSync(process.argv[i + 1], 'utf8'));
const listFiles = process.argv.includes('--listFiles');
let out = '';
if (listFiles) for (const f of cfg.files) out += f + '\\n';
for (const l of ${JSON.stringify(extraLines)}) {
  out += l.split('__TMP__').join(path.dirname(process.argv[i + 1])) + '\\n';
}
fs.writeSync(1, out);
process.exitCode = ${status};
`;
}

test('a compiler killed by a signal AFTER listing every file is loud, not a clean tick', () => {
  // The dangerous case, and the reason `res.signal` is checked before
  // `missing` is computed: a compiler that emits the full `--listFiles`
  // program and is THEN killed (OOM, a CI timeout's SIGKILL) leaves
  // `confirmed` fully populated and `missing` empty. Without the signal
  // check, that reads as every snippet compiled clean - a tick over a
  // compiler that died. This shim lists the program's files exactly like a
  // healthy tsc, then kills itself with SIGKILL before it can print
  // anything else (no exit code, no diagnostics), so `missing.length === 0`
  // and only `res.signal` distinguishes this from a real pass.
  const root = makeTree(`#!/usr/bin/env node
const fs = require('node:fs');
const i = process.argv.indexOf('-p');
const cfg = JSON.parse(fs.readFileSync(process.argv[i + 1], 'utf8'));
let out = '';
if (process.argv.includes('--listFiles')) for (const f of cfg.files) out += f + '\\n';
fs.writeSync(1, out);
process.kill(process.pid, 'SIGKILL');
`);
  try {
    const { status, out } = run(root);
    assert.equal(status, 1, `expected exit 1, got ${status}: ${out}`);
    assert.match(out, /KILLED by SIGKILL/);
    assert.match(out, /Refusing a vacuous pass/);
    assert.doesNotMatch(out, /typecheck clean/, 'must not print a success line at all');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a compiler that cannot be spawned is loud, not a clean tick', () => {
  const root = makeTree(null);
  try {
    const { status, out } = run(root);
    assert.equal(status, 1, `expected exit 1, got ${status}: ${out}`);
    assert.match(out, /could not be RUN/);
    assert.match(out, /ENOENT/);
    assert.match(out, /Refusing a vacuous pass/);
    assert.doesNotMatch(out, /typecheck clean/, 'must not print a success line at all');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a compiler that bails out on the invocation is distinguished from one that found a problem', () => {
  // TS5083 has no file prefix, so neither recovery regex matched it and the
  // gate reported clean. The message must say the compiler could not be
  // CONFIGURED - a different remedy from a broken snippet.
  const root = makeTree('#!/bin/sh\necho "error TS5083: Cannot read file tsconfig.json."\nexit 2\n');
  try {
    const { status, out } = run(root);
    assert.equal(status, 1, `expected exit 1, got ${status}: ${out}`);
    assert.match(out, /could not be CONFIGURED/);
    assert.match(out, /TS5083/);
    assert.doesNotMatch(out, /failed to typecheck/, 'a harness failure, not a snippet failure');
    assert.doesNotMatch(out, /typecheck clean/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a compiler that exits 0 having compiled nothing cannot report a clean run', () => {
  // The count used to be of snippets WRITTEN, so it was structurally incapable
  // of exposing this: 1 snippet written, 0 compiled, "1 snippet ... clean".
  const root = makeTree('#!/bin/sh\nexit 0\n');
  try {
    const { status, out } = run(root);
    assert.equal(status, 1, `expected exit 1, got ${status}: ${out}`);
    assert.match(out, /confirmed only 0 of 1 snippets/);
    assert.match(out, /never compiled: README\.md:4 \(fence #0\)/);
    assert.match(out, /Refusing a vacuous pass/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a real snippet error is reported against the DOC line, not the temp file', () => {
  // The positive control: the recovery path this gate was built for still
  // works, and still resolves the snippet line back to the markdown.
  const root = makeTree(
    workingTsc({
      extraLines: [
        "__TMP__/snippet-000.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      ],
      status: 2,
    }),
  );
  try {
    const { status, out } = run(root);
    assert.equal(status, 1, `expected exit 1, got ${status}: ${out}`);
    assert.match(out, /README\.md:4 \(fence #0\)/);
    assert.match(out, /TS2322/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the listed-snippet regex still matches once the index reaches 4 digits', () => {
  // Snippet files are named with `String(idx).padStart(3, '0')`, so index
  // 1000 (261 snippets today, but the count only grows) is named
  // `snippet-1000.ts`. A regex anchored on exactly 3 digits does not match
  // that name, so every snippet from 1000 on would fail to confirm and the
  // gate would fail a healthy tree - the exact "clean report over untested
  // code" shape #3200 exists to close, just triggered by count rather than
  // by a dead compiler. Extracted straight from the source rather than
  // duplicated here, so this fails if the regex regresses even if nobody
  // remembers this test exists.
  const src = readFileSync(join(HERE, 'check-doc-samples.mjs'), 'utf8');
  const m = src.match(/return (\/\^snippet-[^)]+?\$\/)\.test\(rest\)/);
  assert.ok(m, 'could not locate the listedSnippet regex in check-doc-samples.mjs');
  const re = new RegExp(m[1].slice(1, -1));
  assert.ok(re.test('snippet-1000.ts'), 'index 1000 must still match (padStart(3, "0") never truncates)');
  assert.ok(re.test('snippet-000.ts'), 'the common 3-digit case must keep matching');
  assert.ok(!re.test('snippet-00.ts'), 'fewer than 3 digits must still be rejected');
});

test('a snippet error at a 4-digit index is REPORTED, not silently dropped', () => {
  // The sibling of the test above, in the same file, on the worse side of the
  // asymmetry. `listedSnippet` anchoring on exactly 3 digits made a healthy
  // tree fail; `snippetRe` anchoring on exactly 3 digits made a BROKEN tree
  // pass — a diagnostic that matches none of the three recovery regexes is
  // dropped where the loop falls off its end, so `failures` stays empty and
  // the gate prints its ✅ over a snippet tsc had just rejected.
  //
  // Behavioural rather than a regex extraction: 1001 fences, so the last
  // snippet is genuinely named `snippet-1000.ts` by the gate itself, and the
  // shim reports an error against it by the name the gate chose. Cheap
  // because the compiler is a shim.
  const lines = ['# Sample', ''];
  for (let i = 0; i <= 1000; i++) lines.push('```ts', 'const n: number = 1;', '```', '');
  const root = makeTree(
    workingTsc({
      extraLines: [
        "__TMP__/snippet-1000.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      ],
      status: 2,
    }),
    { readme: lines.join('\n') },
  );
  try {
    const { status, out } = run(root);
    assert.equal(status, 1, `expected exit 1, got ${status}: ${out}`);
    assert.match(out, /failed to typecheck \(1 error\)/);
    // Fence #1000's code line: 2 header lines, then 4 lines per fence.
    assert.match(out, /README\.md:4004 \(fence #1000\)/);
    assert.match(out, /TS2322/);
    assert.doesNotMatch(out, /typecheck clean/, 'a rejected snippet must never read as clean');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a non-zero exit with only out-of-scope diagnostics is still a clean run', () => {
  // Load-bearing, and the reason the fix is not "fail on a non-zero status":
  // against the real repo tsc exits 2 on EVERY run, reporting ~540 errors
  // inside imported package SOURCES, which this gate ignores on purpose. A
  // status-based guard would fail every healthy run; the file list is what
  // separates the two.
  const root = makeTree(
    workingTsc({
      extraLines: [
        'packages/collab/src/detector.ts(91,10): error TS2694: Namespace \'"yjs"\' has no exported member \'Doc\'.',
      ],
      status: 2,
    }),
  );
  try {
    const { status, out } = run(root);
    assert.equal(status, 0, `expected exit 0, got ${status}: ${out}`);
    assert.match(out, /Doc code samples typecheck clean \(1 snippet compiled/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
