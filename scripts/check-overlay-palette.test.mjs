/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for scripts/lib/overlay-palette.mjs, the detection logic behind
 * check-overlay-palette.mjs (#5487). Runs entirely against synthetic source
 * strings and a throwaway fixture tree, never against this checkout's own
 * apps/viewer — same reasoning as check-css-vars.test.mjs and
 * check-asset-usage.test.mjs: a future change to the repo's real files can
 * never make these vacuously pass.
 *
 * Run: `node --test scripts/check-overlay-palette.test.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isViewportFile,
  stripJsComments,
  findHexOrRgbLiterals,
  findPurpleFamilyUtilities,
  findRawZIndex,
} from './lib/overlay-palette.mjs';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const CLI = join(SCRIPTS_DIR, 'check-overlay-palette.mjs');

test('isViewportFile matches components/viewport-ui/** at any depth', () => {
  assert.ok(isViewportFile('apps/viewer/src/components/viewport-ui/hud/ViewportHud.tsx'));
  assert.ok(isViewportFile('apps/viewer/src/components/viewport-ui/scene/primitives/Handle.tsx'));
});

test('isViewportFile matches components/viewer/tools/** at any depth', () => {
  assert.ok(isViewportFile('apps/viewer/src/components/viewer/tools/MeasurementVisuals.tsx'));
  assert.ok(isViewportFile('apps/viewer/src/components/viewer/tools/space-sketch/SpaceSketchCanvas.tsx'));
});

test('isViewportFile matches the named charter overlay files exactly, not by prefix', () => {
  assert.ok(isViewportFile('apps/viewer/src/components/viewer/ViewportContainer.tsx'));
  assert.ok(isViewportFile('apps/viewer/src/components/viewer/bcf/BCFOverlay.tsx'));
  // A sibling file in the same directory as a named overlay file is not
  // automatically in scope — only the exact path is.
  assert.equal(isViewportFile('apps/viewer/src/components/viewer/bcf/BCFPanel.tsx'), false);
});

test('isViewportFile excludes the drawing panel (moved into the panel registry by #5492-5495)', () => {
  assert.equal(isViewportFile('apps/viewer/src/components/viewer/drawing/DrawingPanel.tsx'), false);
  assert.equal(isViewportFile('apps/viewer/src/components/viewer/drawing/ifc-fill-colors.ts'), false);
});

test('isViewportFile excludes an unrelated viewer file', () => {
  assert.equal(isViewportFile('apps/viewer/src/components/viewer/PropertiesPanel.tsx'), false);
});

test('isViewportFile excludes the token module itself (lib/viewport-ui, not components/viewport-ui)', () => {
  assert.equal(isViewportFile('apps/viewer/src/lib/viewport-ui/overlay-theme.ts'), false);
});

test('stripJsComments blanks out // and /* */ comments while preserving line numbers', () => {
  const src = '// #5486 issue ref\nconst x = 1; /* #a855f7 */\nconst y = 2;';
  const stripped = stripJsComments(src);
  assert.equal(stripped.split('\n').length, 3);
  assert.equal(stripped.includes('#5486'), false);
  assert.equal(stripped.includes('#a855f7'), false);
  assert.ok(stripped.includes('const x = 1;'));
  assert.ok(stripped.includes('const y = 2;'));
});

test('findHexOrRgbLiterals finds a hex colour and reports its line', () => {
  const src = 'const a = 1;\nconst stroke = "#9C6BDE";';
  const hits = findHexOrRgbLiterals(src);
  assert.deepEqual(hits.map((h) => [h.line, h.match]), [[2, '#9C6BDE']]);
});

test('findHexOrRgbLiterals finds rgb()/rgba() function calls', () => {
  const src = 'ctx.fillStyle = "rgba(255, 0, 0, 0.5)";\nctx.strokeStyle = "rgb(0,0,0)";';
  const hits = findHexOrRgbLiterals(src);
  assert.deepEqual(hits.map((h) => h.match), ['rgba(', 'rgb(']);
});

test('findHexOrRgbLiterals does not flag an SVG url(#id) fragment reference', () => {
  const src = 'filter="url(#add-elem-glow)"';
  assert.deepEqual(findHexOrRgbLiterals(src), []);
});

test('findHexOrRgbLiterals does not flag an issue number left by a caller that forgot to strip comments', () => {
  // The detector itself does not strip comments (the caller does, via
  // stripJsComments) -- this fixture is plain code containing a bare
  // 4-digit run, proving the length/boundary rule alone does not
  // over-match short numeric-looking hex strings beyond what is real.
  const src = 'const count = 5486;'; // no leading `#`, so never a candidate
  assert.deepEqual(findHexOrRgbLiterals(src), []);
});

test('findHexOrRgbLiterals only matches valid hex-colour lengths (3, 4, 6, 8)', () => {
  const src = '#abc #abcd #abcdef #abcdef12 #abcde #abcdefa';
  const hits = findHexOrRgbLiterals(src).map((h) => h.match);
  assert.deepEqual(hits, ['#abc', '#abcd', '#abcdef', '#abcdef12']);
});

test('findPurpleFamilyUtilities matches purple/violet/indigo/fuchsia shade utilities', () => {
  const src = 'className="bg-purple-500 text-violet-400 border-indigo-300 ring-fuchsia-200 bg-blue-500"';
  const hits = findPurpleFamilyUtilities(src).map((h) => h.match);
  assert.deepEqual(hits, ['purple-500', 'violet-400', 'indigo-300', 'fuchsia-200']);
});

test('findRawZIndex matches a bare z-<digits> utility', () => {
  const hits = findRawZIndex('className="absolute z-40 top-0"');
  assert.deepEqual(hits.map((h) => h.match), ['z-40']);
});

test('findRawZIndex matches an arbitrary z-[...] utility (regression: trailing \\b never matched after "]")', () => {
  const hits = findRawZIndex('className="z-[45] flex"');
  assert.deepEqual(hits.map((h) => h.match), ['z-[45]']);
});

test('findRawZIndex does not match the token z-scale function form from #5483', () => {
  assert.deepEqual(findRawZIndex('className="z-(--z-hud)"'), []);
});

test('findRawZIndex finds both a bracket and a numeric literal on the same line', () => {
  const hits = findRawZIndex('a z-[9999] b z-10 c').map((h) => h.match);
  assert.deepEqual(hits, ['z-[9999]', 'z-10']);
});

// --- CLI end-to-end, against a throwaway fixture tree -----------------------

function makeFixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'overlay-palette-test-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  return root;
}

function writeFixtureFile(root, relPath, content) {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function gitAdd(root) {
  execFileSync('git', ['add', '-A'], { cwd: root });
}

function runCli(root, args = []) {
  try {
    const out = execFileSync('node', [CLI, '--root', root, ...args], { encoding: 'utf-8' });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

test('CLI: --update writes a baseline that then passes cleanly', (t) => {
  const root = makeFixtureRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFixtureFile(
    root,
    'apps/viewer/src/components/viewer/tools/Fixture.tsx',
    'export const x = "#9C6BDE";\n',
  );
  gitAdd(root);

  const update = runCli(root, ['--update']);
  assert.equal(update.code, 0, update.out);
  const baseline = JSON.parse(
    readFileSync(join(root, 'scripts', 'overlay-palette-baseline.json'), 'utf-8'),
  );
  assert.equal(baseline['hexOrRgb:apps/viewer/src/components/viewer/tools/Fixture.tsx'], 1);

  const check = runCli(root);
  assert.equal(check.code, 0, check.out);
});

test('CLI: fails when a file gains a new violation beyond its baseline (mutation-checked: passes before the regression is introduced)', (t) => {
  const root = makeFixtureRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFixtureFile(
    root,
    'apps/viewer/src/components/viewer/tools/Fixture.tsx',
    'export const x = "#9C6BDE";\n',
  );
  gitAdd(root);
  const update = runCli(root, ['--update']);
  assert.equal(update.code, 0, update.out);

  // Before the regression: still green.
  const before = runCli(root);
  assert.equal(before.code, 0, before.out);

  // Introduce a second hex literal in the same file -- a real regression.
  writeFixtureFile(
    root,
    'apps/viewer/src/components/viewer/tools/Fixture.tsx',
    'export const x = "#9C6BDE";\nexport const y = "#a855f7";\n',
  );
  gitAdd(root);
  const after = runCli(root);
  assert.equal(after.code, 1);
  assert.match(after.out, /hexOrRgb.*Fixture\.tsx: 2 \(baseline 1/);
});

test('CLI: a new purple-family utility anywhere in the viewer fails even outside viewport code', (t) => {
  const root = makeFixtureRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFixtureFile(root, 'apps/viewer/src/components/viewer/PropertiesPanel.tsx', 'export const ok = 1;\n');
  gitAdd(root);
  const update = runCli(root, ['--update']);
  assert.equal(update.code, 0, update.out);

  writeFixtureFile(
    root,
    'apps/viewer/src/components/viewer/PropertiesPanel.tsx',
    'export const cls = "bg-purple-500";\n',
  );
  gitAdd(root);
  const after = runCli(root);
  assert.equal(after.code, 1);
  assert.match(after.out, /purpleFamily.*PropertiesPanel\.tsx: 1 \(baseline 0/);
});

test('CLI: an improvement (count drops below baseline) is reported but does not fail the build', (t) => {
  const root = makeFixtureRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFixtureFile(
    root,
    'apps/viewer/src/components/viewer/tools/Fixture.tsx',
    'export const x = "#9C6BDE";\nexport const y = "#a855f7";\n',
  );
  gitAdd(root);
  const update = runCli(root, ['--update']);
  assert.equal(update.code, 0, update.out);

  writeFixtureFile(
    root,
    'apps/viewer/src/components/viewer/tools/Fixture.tsx',
    'export const x = "#9C6BDE";\n',
  );
  gitAdd(root);
  const after = runCli(root);
  assert.equal(after.code, 0, after.out);
  assert.match(after.out, /improved/);
});

test('CLI: fails closed with no baseline file present', (t) => {
  const root = makeFixtureRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFixtureFile(root, 'apps/viewer/src/components/viewer/PropertiesPanel.tsx', 'export const ok = 1;\n');
  gitAdd(root);
  const result = runCli(root);
  assert.equal(result.code, 1);
  assert.match(result.out, /no baseline/);
});
