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
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  chmodSync,
  rmSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
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
function makeTree(tscShim, { readme = README, packages = [], fillFloor = true } = {}) {
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

  // PACKAGE_README_FLOOR published READMEs, so the floor never fires in a test
  // that is about something else. Their READMEs carry NO ts fence, so every
  // snippet count asserted below still counts only the docs the test wrote.
  if (fillFloor) {
    for (let i = 0; i < 25; i++) {
      const dir = join(root, 'packages', `filler${i}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'package.json'),
        `${JSON.stringify({ name: `@filler/p${i}`, version: '0.0.0' })}\n`,
        'utf8',
      );
      writeFileSync(join(dir, 'README.md'), `# filler${i}\n\nNo code here.\n`, 'utf8');
    }
  }

  // `packages` entries are `{ dir, name, private?, readme? }`. A package with
  // no `readme` ships none at all, which is check-package-readmes.mjs's
  // verdict to report, not this gate's.
  for (const p of packages) {
    const dir = join(root, 'packages', p.dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      `${JSON.stringify({ name: p.name, version: '0.0.0', private: p.private === true })}\n`,
      'utf8',
    );
    if (p.readme !== undefined) writeFileSync(join(dir, 'README.md'), p.readme, 'utf8');
  }

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

// ---------------------------------------------------------------------------
// #3846: package READMEs are in the target set.
//
// `targetDocs()` used to return the root README plus docs/guide and
// docs/tutorials only, so every packages/*/README.md - the npm landing pages,
// the most copy-pasted code in the repo - was the one class of docs with no
// typecheck at all. That is how packages/cache/README.md shipped a quickstart
// with two TS2345 errors (#3759): check-package-readmes.mjs asserted the file
// EXISTED and nothing looked inside it.
//
// These three drive the gate over a synthetic tree holding a package, rather
// than asserting on the shape of `targetDocs()`, because inclusion in the list
// is not the property that matters - being COMPILED is, and the gate reports
// on the files tsc named, not the files it wrote (see #3200 above).
// ---------------------------------------------------------------------------

/** A package README with a snippet whose error the shim will report. */
const PKG_README = ['# @scope/thing', '', '```ts', 'const s: string = 1;', '```', ''].join('\n');

test("a published package's README is compiled, not merely required to exist", () => {
  // A tsc that exits 0 having compiled nothing names every snippet the gate
  // put in the program, so this is a positive assertion about MEMBERSHIP: had
  // targetDocs() left package READMEs out, the package snippet would not be
  // among the ones reported never-compiled, and the count would be 1, not 2.
  const root = makeTree('#!/bin/sh\nexit 0\n', {
    packages: [{ dir: 'thing', name: '@scope/thing', readme: PKG_README }],
  });
  try {
    const { status, out } = run(root);
    assert.equal(status, 1, `expected exit 1, got ${status}: ${out}`);
    assert.match(out, /confirmed only 0 of 2 snippets/);
    assert.match(
      out,
      /never compiled: packages[/\\]thing[/\\]README\.md:4 \(fence #0\)/,
      'the package README must be in the program at all',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a broken snippet in a package README is REPORTED against that README", () => {
  // The gate's whole purpose, aimed at the file class it used to skip. The
  // root README's snippet is snippet-000; the package README's is snippet-001,
  // because targetDocs() appends packages after the root README and the guides.
  const root = makeTree(
    workingTsc({
      extraLines: [
        "__TMP__/snippet-001.ts(1,7): error TS2322: Type 'number' is not assignable to type 'string'.",
      ],
      status: 2,
    }),
    { packages: [{ dir: 'thing', name: '@scope/thing', readme: PKG_README }] },
  );
  try {
    const { status, out } = run(root);
    assert.equal(status, 1, `expected exit 1, got ${status}: ${out}`);
    assert.match(out, /failed to typecheck \(1 error\)/);
    assert.match(out, /packages[/\\]thing[/\\]README\.md:4 \(fence #0\)/);
    assert.match(out, /TS2322/);
    assert.doesNotMatch(out, /typecheck clean/, 'a rejected snippet must never read as clean');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a PRIVATE package\'s README is not in the target set', () => {
  // Pins the half of the rule that says which READMEs are in scope. It is
  // check-package-readmes.mjs's rule verbatim - `private: true` is not
  // published - and the two gates must cover the same set: a README that gate
  // does not require to exist is not one this gate can insist compiles.
  // Without this, "include every packages/*/README.md" would look identical.
  const root = makeTree('#!/bin/sh\nexit 0\n', {
    packages: [{ dir: 'inner', name: '@scope/inner', private: true, readme: PKG_README }],
  });
  try {
    const { status, out } = run(root);
    assert.equal(status, 1, `expected exit 1, got ${status}: ${out}`);
    assert.match(out, /confirmed only 0 of 1 snippets/, 'only the root README snippet is in scope');
    assert.doesNotMatch(out, /packages[/\\]inner/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a published package with no README is left to check-package-readmes', () => {
  // targetDocs() must not hand a nonexistent path to extractBlocks: that would
  // be an ENOENT stack trace from this gate over a condition the README gate
  // reports properly, and a crash here reads as "the docs check is broken"
  // rather than "a package is missing its landing page".
  const root = makeTree(workingTsc(), {
    packages: [{ dir: 'bare', name: '@scope/bare' }],
  });
  try {
    const { status, out } = run(root);
    assert.equal(status, 0, `expected exit 0, got ${status}: ${out}`);
    assert.match(out, /Doc code samples typecheck clean \(1 snippet compiled/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// #3846 review: the published-package rule must MATCH check-package-readmes.mjs
// and must refuse to go quiet.
// ---------------------------------------------------------------------------

test('a package manifest that cannot be READ is fatal, not silently dropped', () => {
  // The sibling gate's finding, one gate over: `existsSync` answers false for
  // ENOTDIR and EACCES as well as ENOENT, so an unreadable package left the
  // walk and its README's snippets left with it — a clean tick over docs
  // nothing looked at, which is the whole #3846 subject.
  const root = makeTree(workingTsc());
  try {
    // A FILE where a package directory belongs: statting its package.json is
    // ENOTDIR.
    writeFileSync(join(root, 'packages', 'locked'), 'not a directory', 'utf8');
    const { status, out } = run(root);
    assert.equal(status, 1, `expected exit 1, got ${status}: ${out}`);
    assert.match(out, /cannot read package manifest .*locked[/\\]package\.json \(ENOTDIR\)/);
    assert.match(out, /without anyone noticing/);
    assert.doesNotMatch(out, /typecheck clean/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('too few package READMEs reaching the typecheck is refused, not reported clean', () => {
  // Without the floor, a walk that stopped finding package READMEs at all —
  // wrong ROOT, restructured packages/ — reports the guides as a clean run and
  // says nothing about the class of docs it stopped covering. That silence IS
  // the pre-#3846 behaviour, so it must not be reachable by accident again.
  const root = makeTree(workingTsc(), { fillFloor: false });
  try {
    const { status, out } = run(root);
    assert.equal(status, 1, `expected exit 1, got ${status}: ${out}`);
    assert.match(out, /only 0 published-package README\(s\) reached the doc-samples typecheck/);
    assert.match(out, /expected at least 25/);
    // The remedy must NAME the constant, as the sibling gate's does.
    assert.match(out, /lower PACKAGE_README_FLOOR in this file/);
    assert.doesNotMatch(out, /typecheck clean/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A tree that mirrors the REAL `packages/` layout: one directory per real
 * package, carrying that package's real manifest (so `private` and `name` are
 * the real ones), and a one-snippet README wherever the real package has one.
 *
 * Both gates derive ROOT from their own location, so copying both into this
 * tree runs both REAL rules over the real package set without either gate
 * growing a scan-root flag.
 */
function mirrorRealPackages() {
  const repoPackages = join(HERE, '..', '..', 'packages');
  const root = mkdtempSync(join(tmpdir(), 'doc-samples-parity-'));
  mkdirSync(join(root, 'scripts', 'docs'), { recursive: true });
  mkdirSync(join(root, 'docs', 'guide'), { recursive: true });
  mkdirSync(join(root, 'docs', 'tutorials'), { recursive: true });
  mkdirSync(join(root, 'packages'), { recursive: true });
  mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
  for (const f of [
    'check-doc-samples.mjs',
    'check-package-readmes.mjs',
    'doc-samples-globals.d.ts',
    'doc-samples-externals.d.ts',
  ]) {
    copyFileSync(join(HERE, f), join(root, 'scripts', 'docs', f));
  }
  writeFileSync(join(root, 'README.md'), README, 'utf8');

  const withReadme = [];
  for (const dir of readdirSync(repoPackages).sort()) {
    if (dir.startsWith('.')) continue;
    const manifest = join(repoPackages, dir, 'package.json');
    let text;
    try {
      text = readFileSync(manifest, 'utf8');
    } catch {
      continue;
    }
    mkdirSync(join(root, 'packages', dir), { recursive: true });
    writeFileSync(join(root, 'packages', dir, 'package.json'), text, 'utf8');
    let hasReadme = true;
    try {
      readFileSync(join(repoPackages, dir, 'README.md'), 'utf8');
    } catch {
      hasReadme = false;
    }
    if (hasReadme) {
      writeFileSync(join(root, 'packages', dir, 'README.md'), README, 'utf8');
      withReadme.push(dir);
    }
  }
  return { root, withReadme };
}

test('both gates agree on which packages/* are published', () => {
  // The two gates are only as aligned as their two copies of one rule. This
  // drives BOTH real rules over the real package layout and compares the sets:
  // the READMEs check-package-readmes REQUIRES to exist must be exactly the
  // READMEs check-doc-samples TYPECHECKS. Drift either way is silent — a
  // README nobody requires, or a landing page nobody compiles.
  const { root, withReadme } = mirrorRealPackages();
  try {
    // Set A: every doc check-doc-samples put in its program. A tsc that
    // reports an error against EVERY snippet makes the gate print one line per
    // snippet with its doc path, which the truncated never-compiled listing
    // could not give.
    writeFileSync(
      join(root, 'node_modules', '.bin', 'tsc'),
      `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const i = process.argv.indexOf('-p');
const cfg = JSON.parse(fs.readFileSync(process.argv[i + 1], 'utf8'));
let out = '';
if (process.argv.includes('--listFiles')) for (const f of cfg.files) out += f + '\\n';
for (const f of cfg.files) {
  if (/snippet-\\d+\\.ts$/.test(f)) out += f + "(1,7): error TS2322: parity probe.\\n";
}
fs.writeSync(1, out);
process.exitCode = 2;
`,
      'utf8',
    );
    chmodSync(join(root, 'node_modules', '.bin', 'tsc'), 0o755);

    const samples = run(root);
    assert.equal(samples.status, 1, samples.out);
    const typechecked = new Set(
      [...samples.out.matchAll(/packages[/\\]([^/\\]+)[/\\]README\.md:/g)].map((m) => m[1]),
    );

    // Set B: check-package-readmes' own published set. Read out by removing
    // every package README first — the list it then reports as MISSING is
    // exactly the set it audits, named by that gate rather than restated here.
    for (const dir of withReadme) rmSync(join(root, 'packages', dir, 'README.md'));
    const readmes = spawnSync(
      process.execPath,
      [join(root, 'scripts', 'docs', 'check-package-readmes.mjs')],
      { cwd: root, encoding: 'utf8' },
    );
    const out = `${readmes.stdout ?? ''}${readmes.stderr ?? ''}`;
    assert.equal(readmes.status, 1, out);
    const required = new Set(
      [...out.matchAll(/\(packages[/\\]([^/\\]+)[/\\]README\.md\)/g)].map((m) => m[1]),
    );

    assert.ok(required.size >= 25, `expected the real tree to hold 25+ published packages, got ${required.size}`);
    // Stated as sorted arrays so a mismatch names the packages that drifted.
    assert.deepEqual(
      [...typechecked].sort(),
      [...required].sort(),
      'check-doc-samples and check-package-readmes disagree on the published set',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
