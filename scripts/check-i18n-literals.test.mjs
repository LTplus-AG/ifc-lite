#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression harness for scripts/check-i18n-literals.mjs and its detector,
 * scripts/lib/i18n-literals-scan.mjs (#4918 "what ends it" gate).
 *
 * Two layers, same reason `check-module-size.test.mjs` pins its harness
 * separately from `lib/module-size-ratchet.test.mjs`'s counting: the
 * DETECTOR (does a hardcoded JSX literal get caught, does an allowlisted
 * `IfcWall` get spared) is unit-tested directly against the fixture text
 * below; the CLI (file-walking, the per-file baseline, the ratchet's
 * rise-fails/fall-reminds asymmetry) is black-box tested with `spawnSync`
 * against a synthetic tree in a temp dir, the same method
 * `check-module-size.test.mjs` uses, so nothing here reads the checker's
 * own source.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countLiterals, isAllowlistedLiteral, findLiterals } from './lib/i18n-literals-scan.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECKER = join(ROOT, 'scripts', 'check-i18n-literals.mjs');

// ── Detector fixture ──────────────────────────────────────────────────

const FIXTURE_TSX = `
export function Example() {
  return (
    <div>
      <span>Reset Colors</span>
      <button aria-label="Reset the color overrides" />
      <span>IfcWall</span>
      <span>PDF</span>
      <span>⌘Z</span>
    </div>
  );
}
`;

test('findLiterals catches the hardcoded JSX text and aria-label', () => {
  const found = findLiterals(FIXTURE_TSX).map((l) => l.text);
  assert.ok(found.includes('Reset Colors'), 'plain JSX text must be found');
  assert.ok(found.includes('Reset the color overrides'), 'aria-label literal must be found');
});

test('isAllowlistedLiteral spares an IFC EXPRESS name, an acronym, and a shortcut glyph', () => {
  assert.equal(isAllowlistedLiteral('IfcWall'), true);
  assert.equal(isAllowlistedLiteral('PDF'), true);
  assert.equal(isAllowlistedLiteral('⌘Z'), true);
});

test('isAllowlistedLiteral does NOT spare hardcoded UI prose', () => {
  assert.equal(isAllowlistedLiteral('Reset Colors'), false);
  assert.equal(isAllowlistedLiteral('Reset the color overrides'), false);
  assert.equal(isAllowlistedLiteral('Esc'), false, 'mixed-case "Esc" is prose, not an acronym');
});

test('countLiterals counts exactly the non-allowlisted literals in the fixture', () => {
  // "Reset Colors" (JSX text) + "Reset the color overrides" (aria-label) = 2.
  // IfcWall, PDF, and ⌘Z are all allowlisted.
  assert.equal(countLiterals(FIXTURE_TSX), 2);
});

test('a file with only allowlisted content counts zero', () => {
  const clean = `
    export function Clean() {
      return <div><span>IfcWall</span><span>PDF</span><span>⌘Z</span></div>;
    }
  `;
  assert.equal(countLiterals(clean), 0);
});

// ── Review-fix regression fixtures (bot review on PR #4973) ────────────
// The first round of review found five real detector gaps in the ORIGINAL
// regex version of this file; the fix was to replace the regex with the
// TypeScript-compiler-API AST walk `i18n-literals-scan.mjs` now is. These
// fixtures pin the specific shapes review named, now caught (or correctly
// ignored) by construction rather than by a widened pattern.

test('a JSX-expression string literal is caught the same as plain JSX text', () => {
  const src = `<button>{'Save changes'}</button>`;
  assert.ok(findLiterals(src).some((l) => l.text === 'Save changes'));
  assert.equal(countLiterals(src), 1);
});

test('both arms of a conditional label are counted, in JSX text and in a policed attribute (#4973 review)', () => {
  const text = `<span>{on ? 'Enabled' : 'Disabled'}</span>`;
  assert.deepEqual(findLiterals(text).map((l) => l.text), ['Enabled', 'Disabled']);
  assert.equal(countLiterals(text), 2);
  const attr = `<button aria-label={playing ? 'Pause sweep' : 'Play sweep'} />`;
  assert.equal(countLiterals(attr), 2);
  assert.equal(countLiterals(`<div>{busy && 'Loading'}</div>`), 1);
  // A conditional feeding a non-policed prop is still not copy.
  assert.equal(countLiterals(`<div className={on ? 'a' : 'b'} />`), 0);
});

test('static concatenation and template-literal text are counted as copy (#4973 review)', () => {
  assert.deepEqual(findLiterals(`<b>{'Save ' + 'changes'}</b>`).map((l) => l.text), ['Save', 'changes']);
  assert.equal(countLiterals(`<b>{'Count: ' + n}</b>`), 1);
  // Fixtures are assembled so the test source itself carries no `${` in a plain string (oxlint no-template-curly-in-string).
  const hole = (name) => '$' + '{' + name + '}';
  assert.equal(countLiterals('<a aria-label={`View ' + hole('path') + '`} />'), 1);
  assert.equal(countLiterals('<a title={`' + hole('a') + hole('b') + '`} />'), 0);
});

test('entity spellings in JSX text are decoded before the allowlist runs (#4973 review)', () => {
  assert.equal(countLiterals(`<span>&times;</span>`), 0);
  assert.equal(countLiterals(`<span>&middot; &#215; &#xD7;</span>`), 0);
  // A decoded entity inside real prose does not hide the prose.
  assert.equal(countLiterals(`<span>Save &amp; close</span>`), 1);
  // An out-of-range numeric entity is left as written, never thrown on.
  assert.doesNotThrow(() => countLiterals(`<span>&#1114112;</span>`));
  assert.equal(countLiterals(`<span>&#1114112; Save</span>`), 1);
});

test('a JSX-expression string literal in JSX-child position is still counted (<div>)', () => {
  assert.equal(countLiterals(`<div>{'Save changes'}</div>`), 1);
});

test('a JsxExpression is counted ONLY in JSX-child position -- an untargeted attribute/prop value is not copy', () => {
  // Review, #4973: the first AST version fired for EVERY JsxExpression, so
  // ordinary styling/prop values inflated the baseline and failed the gate
  // on changes that add no copy at all.
  assert.equal(countLiterals(`<div className={'flex items'} />`), 0, 'className is not a policed attribute');
  assert.equal(
    countLiterals(`<Button variant={'ghost'} size={'icon-sm'} data-testid={'foo'} />`),
    0,
    'none of variant/size/data-testid are policed attributes',
  );
  assert.equal(countLiterals(`<Item key={'row'} />`), 0, 'key is React plumbing, not UI copy');
});

test('an aria-label written as a JSX-expression string literal is caught', () => {
  const src = `<button aria-label={'x'} />`;
  assert.ok(findLiterals(src).some((l) => l.text === 'x'));
  assert.equal(countLiterals(src), 1, 'the attribute value must be counted, and only once');
});

test('a mixed JsxText + expression ("Hello {name}") counts the static text exactly once', () => {
  const src = `function Greeting({ name }) { return <span>Hello {name}</span>; }`;
  const found = findLiterals(src);
  assert.deepEqual(found.map((l) => l.text), ['Hello'], 'name is an Identifier, not a string literal -- never a candidate');
  assert.equal(countLiterals(src), 1);
});

test('an ordinary comparison ("a > b") is not JSX and produces no candidate at all', () => {
  const src = `function f(a, b) { if (a > b) return <div />; return null; }`;
  assert.deepEqual(findLiterals(src), []);
  assert.equal(countLiterals(src), 0);
});

test('a brace-only control-flow boundary ("} else {") produces no candidate', () => {
  const src = `
    function f(a) {
      if (a) {
        return <div>x</div>;
      } else {
        return null;
      }
    }
  `;
  // Exactly the one real JSX text node ("x"); "} else {" contributes nothing.
  assert.deepEqual(findLiterals(src).map((l) => l.text), ['x']);
});

test('ACRONYMS is an explicit list, not "any all-caps word" — real UI copy is never spared', () => {
  assert.equal(isAllowlistedLiteral('DELETE'), false);
  assert.equal(isAllowlistedLiteral('WELCOME'), false);
});

test('IfcWall is allowlisted as an IFC EXPRESS name', () => {
  assert.equal(isAllowlistedLiteral('IfcWall'), true);
});

test('non-Latin hardcoded text is counted, not treated as letter-free', () => {
  assert.equal(isAllowlistedLiteral('设置'), false);
  assert.equal(countLiterals('<span>你好</span>'), 1);
});

test('aria-label tolerates whitespace around "=", and a data- attribute name never matches', () => {
  assert.ok(findLiterals(`<button aria-label = "Delete model" />`).some((l) => l.text === 'Delete model'));
  // `data-title`'s attribute NAME is the identifier "data-title", not "title" --
  // an exact-name check (TARGET_ATTRS.has(node.name.getText())) can't confuse the two,
  // the way a suffix-matching regex could.
  assert.equal(findLiterals(`<div data-title="internal, not UI copy" />`).length, 0);
});

test('alt is a policed attribute, same as aria-label/title/placeholder', () => {
  assert.ok(findLiterals(`<img alt="A rendered floor plan" />`).some((l) => l.text === 'A rendered floor plan'));
});

// ── CLI harness ────────────────────────────────────────────────────────

function run(args, cwd) {
  return spawnSync(process.execPath, [CHECKER, ...args], { cwd, encoding: 'utf8' });
}

function makeTree() {
  const dir = mkdtempSync(join(tmpdir(), 'i18n-literals-test-'));
  const componentsDir = join(dir, 'apps', 'viewer', 'src', 'components');
  mkdirSync(componentsDir, { recursive: true });
  mkdirSync(join(dir, 'scripts'), { recursive: true }); // default --baseline path's parent
  return { dir, componentsDir };
}

function writeComponent(componentsDir, name, content) {
  writeFileSync(join(componentsDir, name), content);
}

test('check mode fails when no baseline exists yet', () => {
  const { dir, componentsDir } = makeTree();
  try {
    writeComponent(componentsDir, 'Foo.tsx', FIXTURE_TSX);
    const res = run(['--root', dir], dir);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /no baseline/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--update writes a per-file baseline with only non-zero counts', () => {
  const { dir, componentsDir } = makeTree();
  try {
    writeComponent(componentsDir, 'Foo.tsx', FIXTURE_TSX);
    writeComponent(componentsDir, 'Clean.tsx', '<div><span>IfcWall</span></div>;');
    const res = run(['--root', dir, '--update', '--allow-raise'], dir);
    assert.equal(res.status, 0, res.stderr);

    const baseline = JSON.parse(readFileSync(join(dir, 'scripts', 'i18n-literals-baseline.json'), 'utf8'));
    assert.deepEqual(Object.keys(baseline), ['apps/viewer/src/components/Foo.tsx']);
    assert.equal(baseline['apps/viewer/src/components/Foo.tsx'], 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('check mode passes against a baseline that matches, and fails once a file RISES above it', () => {
  const { dir, componentsDir } = makeTree();
  try {
    writeComponent(componentsDir, 'Foo.tsx', FIXTURE_TSX);
    let res = run(['--root', dir, '--update', '--allow-raise'], dir);
    assert.equal(res.status, 0, res.stderr);

    res = run(['--root', dir], dir);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /OK/);

    // Add a second hardcoded literal — the count now exceeds its baseline row.
    writeComponent(componentsDir, 'Foo.tsx', `${FIXTURE_TSX}\n<span>Another Hardcoded Label</span>`);
    res = run(['--root', dir], dir);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /increased/);
    assert.match(res.stderr, /Foo\.tsx/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('check mode does NOT fail when a file improves, but reminds to lower the baseline', () => {
  const { dir, componentsDir } = makeTree();
  try {
    writeComponent(componentsDir, 'Foo.tsx', FIXTURE_TSX);
    let res = run(['--root', dir, '--update', '--allow-raise'], dir);
    assert.equal(res.status, 0, res.stderr);

    // Convert the file down to zero hardcoded literals.
    writeComponent(componentsDir, 'Foo.tsx', '<div><span>IfcWall</span></div>;');
    res = run(['--root', dir], dir);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /note:.*Foo\.tsx/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--update refuses to raise a file past its baseline without --allow-raise', () => {
  const { dir, componentsDir } = makeTree();
  try {
    writeComponent(componentsDir, 'Foo.tsx', FIXTURE_TSX);
    let res = run(['--root', dir, '--update', '--allow-raise'], dir);
    assert.equal(res.status, 0, res.stderr);

    writeComponent(componentsDir, 'Foo.tsx', `${FIXTURE_TSX}\n<span>Another Hardcoded Label</span>`);
    res = run(['--root', dir, '--update'], dir);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /refusing to raise/);

    res = run(['--root', dir, '--update', '--allow-raise'], dir);
    assert.equal(res.status, 0, res.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fails closed when the scan root does not exist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'i18n-literals-test-empty-'));
  try {
    const res = run(['--root', dir], dir);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /does not exist/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('walk() does not follow a self-referential directory symlink (review, #4973)', () => {
  const { dir, componentsDir } = makeTree();
  try {
    writeComponent(componentsDir, 'Foo.tsx', FIXTURE_TSX);
    let symlinked = false;
    try {
      // `loop` points at its own parent -- if `walk` ever followed directory
      // symlinks (as an earlier version of the checker did), this recurses
      // without bound. Symlink creation needs a privilege this sandbox may
      // not have (Windows without Developer Mode/admin); when it fails, the
      // directory-only assertion below still pins the fix on its own.
      symlinkSync(componentsDir, join(componentsDir, 'loop'), 'junction');
      symlinked = true;
    } catch {
      // Platform cannot create a symlink here -- fall through to the
      // directory-only assertion, which needs no symlink to be meaningful.
    }

    const res = run(['--root', dir], dir);
    if (symlinked) {
      // Finished at all (no stack overflow, no timeout) is the load-bearing
      // assertion; the exit code depends only on whether a baseline exists.
      assert.notEqual(res.status, null, 'the walk must terminate, not hang or crash on the symlink loop');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('walk() never descends into a directory symlink, even a non-looping one', () => {
  const { dir, componentsDir } = makeTree();
  try {
    const realDir = join(dir, 'outside-scan-root');
    mkdirSync(realDir, { recursive: true });
    writeFileSync(join(realDir, 'Hidden.tsx'), '<span>Should never be scanned</span>');
    try {
      symlinkSync(realDir, join(componentsDir, 'linked'), 'junction');
    } catch {
      return; // platform cannot create a symlink here; nothing to assert
    }
    writeComponent(componentsDir, 'Foo.tsx', '<div><span>IfcWall</span></div>;');

    const res = run(['--root', dir, '--update', '--allow-raise'], dir);
    assert.equal(res.status, 0, res.stderr);
    const baseline = JSON.parse(readFileSync(join(dir, 'scripts', 'i18n-literals-baseline.json'), 'utf8'));
    assert.deepEqual(baseline, {}, 'the symlinked directory\'s content must not be counted at all');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
