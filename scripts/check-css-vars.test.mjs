/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for scripts/lib/css-vars.mjs, the detection logic behind
 * check-css-vars.mjs (#5479). Runs entirely against synthetic CSS/source
 * strings, never against this checkout's own apps/viewer — same reasoning as
 * check-asset-usage.test.mjs: a future change to the repo's real files can
 * never make these vacuously pass.
 *
 * Run: `node --test scripts/check-css-vars.test.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { extractDefinedCssVars, extractVarReferences, isAllowedUndefined, findUndefinedCssVarRefs } from './lib/css-vars.mjs';

test('extractDefinedCssVars finds a var declared in any selector, including @theme', () => {
  const css = `
:root { --tokyo-blue: #7aa2f7; }
@theme {
  --color-primary: var(--tokyo-blue);
}
.dark { --color-primary: var(--tokyo-blue); }
`;
  const defined = extractDefinedCssVars(css);
  assert.ok(defined.has('--tokyo-blue'));
  assert.ok(defined.has('--color-primary'));
});

test('extractDefinedCssVars ignores a var name mentioned only in a comment', () => {
  const css = `
/* --tokyo-comment (#565f89) is ~2.5:1 on dark surfaces */
:root { --tokyo-fg: #a9b1d6; }
`;
  const defined = extractDefinedCssVars(css);
  assert.equal(defined.has('--tokyo-comment'), false);
  assert.ok(defined.has('--tokyo-fg'));
});

test('extractDefinedCssVars does not see a declaration commented out', () => {
  const css = `/* --dead-token: #fff; */\n:root { --live-token: #000; }`;
  const defined = extractDefinedCssVars(css);
  assert.equal(defined.has('--dead-token'), false);
  assert.ok(defined.has('--live-token'));
});

test('extractVarReferences finds a fallback-less reference and its line', () => {
  const src = `line 1\nstroke="hsl(var(--primary))"\nline 3`;
  const refs = extractVarReferences(src);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].name, '--primary');
  assert.equal(refs[0].hasFallback, false);
  assert.equal(refs[0].line, 2);
});

test('extractVarReferences marks a var(--x, fallback) reference as having a fallback', () => {
  const src = `background: var(--background, #fff);`;
  const refs = extractVarReferences(src);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].name, '--background');
  assert.equal(refs[0].hasFallback, true);
});

test('extractVarReferences finds multiple references on one line independently', () => {
  const src = `var(--a) var(--b, 1) var(--c)`;
  const refs = extractVarReferences(src);
  assert.deepEqual(refs.map((r) => [r.name, r.hasFallback]), [
    ['--a', false],
    ['--b', true],
    ['--c', false],
  ]);
});

test('isAllowedUndefined matches a prefix row regardless of the exact suffix', () => {
  const prefixAllowlist = [{ prefix: '--radix-', reason: 'Radix publishes these at runtime.' }];
  const a = isAllowedUndefined({ name: '--radix-select-trigger-width', file: 'x.tsx', fileAllowlist: [], prefixAllowlist });
  const b = isAllowedUndefined({ name: '--radix-dropdown-menu-content-available-height', file: 'x.tsx', fileAllowlist: [], prefixAllowlist });
  assert.equal(a.allowed, true);
  assert.equal(b.allowed, true);
});

test('isAllowedUndefined only allows a file-scoped name in its named file', () => {
  const fileAllowlist = [{ file: 'apps/viewer/src/components/mcp/McpLanding.tsx', names: ['--accent'], reason: 'inline style writer' }];
  const inFile = isAllowedUndefined({ name: '--accent', file: 'apps/viewer/src/components/mcp/McpLanding.tsx', fileAllowlist, prefixAllowlist: [] });
  const otherFile = isAllowedUndefined({ name: '--accent', file: 'apps/viewer/src/components/viewer/tools/MeasurementVisuals.tsx', fileAllowlist, prefixAllowlist: [] });
  assert.equal(inFile.allowed, true);
  assert.equal(otherFile.allowed, false);
});

test('findUndefinedCssVarRefs reproduces the #5479 shape: reds on hsl(var(--primary)) with no fallback', () => {
  const sourceFiles = [
    { path: 'apps/viewer/src/components/viewer/tools/MeasurementVisuals.tsx', content: 'stroke="hsl(var(--primary))"\nfill="hsl(var(--primary))"' },
  ];
  const definedVars = new Set(['--color-primary']); // --primary is never declared
  const { violations } = findUndefinedCssVarRefs({ sourceFiles, definedVars, fileAllowlist: [], prefixAllowlist: [] });
  assert.equal(violations.length, 2);
  assert.equal(violations[0].name, '--primary');
  assert.equal(violations[0].line, 1);
  assert.equal(violations[1].line, 2);
});

test('findUndefinedCssVarRefs is green once the reference points at a real token', () => {
  const sourceFiles = [
    { path: 'apps/viewer/src/components/viewer/tools/MeasurementVisuals.tsx', content: 'stroke="var(--color-primary)"' },
  ];
  const definedVars = new Set(['--color-primary']);
  const { violations } = findUndefinedCssVarRefs({ sourceFiles, definedVars, fileAllowlist: [], prefixAllowlist: [] });
  assert.deepEqual(violations, []);
});

test('findUndefinedCssVarRefs never flags a reference that carries a fallback, defined or not', () => {
  const sourceFiles = [
    { path: 'apps/viewer/src/services/panel-windows.ts', content: "target.body.style.background = 'var(--background, #fff)';" },
  ];
  const { violations } = findUndefinedCssVarRefs({ sourceFiles, definedVars: new Set(), fileAllowlist: [], prefixAllowlist: [] });
  assert.deepEqual(violations, []);
});

test('findUndefinedCssVarRefs reports allowlistRowsUsed only for rows that actually matched', () => {
  const fileAllowlist = [
    { file: 'apps/viewer/src/components/mcp/McpLanding.tsx', names: ['--accent'], reason: 'used' },
    { file: 'apps/viewer/src/hooks/ids/idsExportService.ts', names: ['--bg'], reason: 'never matched in this fixture' },
  ];
  const sourceFiles = [
    { path: 'apps/viewer/src/components/mcp/McpLanding.tsx', content: 'className="hover:text-[var(--accent)]"' },
  ];
  const { violations, allowlistRowsUsed } = findUndefinedCssVarRefs({ sourceFiles, definedVars: new Set(), fileAllowlist, prefixAllowlist: [] });
  assert.deepEqual(violations, []);
  assert.equal(allowlistRowsUsed.length, 1);
  assert.equal(allowlistRowsUsed[0].file, 'apps/viewer/src/components/mcp/McpLanding.tsx');
});

test('findUndefinedCssVarRefs does not allow an allowlisted name in an unlisted file', () => {
  const fileAllowlist = [{ file: 'apps/viewer/src/components/mcp/McpLanding.tsx', names: ['--accent'], reason: 'scoped' }];
  const sourceFiles = [
    { path: 'apps/viewer/src/components/viewer/tools/MeasurementVisuals.tsx', content: 'stroke="var(--accent)"' },
  ];
  const { violations } = findUndefinedCssVarRefs({ sourceFiles, definedVars: new Set(), fileAllowlist, prefixAllowlist: [] });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].name, '--accent');
});
