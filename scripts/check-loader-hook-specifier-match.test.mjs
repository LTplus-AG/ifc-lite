#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression harness for scripts/check-loader-hook-specifier-match.mjs.
 *
 * The RED is not synthetic: `PRE_FIX_HYDRATE_HOOK` below is
 * `apps/viewer/src/test/collab-hydrate-gate-hook.mjs` exactly as it was written
 * in 50568bd43 — the second time the repo shipped a `register()` loader hook
 * that could only match a bare specifier. Per 73571eb46's own reproduction, it
 * hung `collabSlice.leave-after-reconstruct.test.ts` 3 of 3 on Node 22.23.2 and
 * passed on 22.13.1. `FIXED_HYDRATE_HOOK` is the same file after 73571eb46. The
 * two differ only in the `resolve` arm, so a rule that reds the first and greens
 * the second is measuring the thing the incident was about.
 *
 * The other half of the suite is anti-vacuity: every way this guard could scan
 * nothing and pass — a missing search root, an empty tree, no hooks, an
 * unreadable file, a `resolve` with no locatable condition — is asserted to be a
 * non-zero exit with a named reason, because a guard that finds nothing to guard
 * passes forever.
 *
 * Method matches scripts/check-collab-room-model-target.test.mjs: build a tree
 * in a temp dir outside the repo and run the UNMODIFIED checker against it via
 * `--root`.
 *
 * Run: node --test scripts/check-loader-hook-specifier-match.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPTS, '..');
const CHECKER = join(SCRIPTS, 'check-loader-hook-specifier-match.mjs');

const HOOK_REL = 'apps/viewer/src/test/collab-hydrate-gate-hook.mjs';

/**
 * `apps/viewer/src/test/collab-hydrate-gate-hook.mjs` @ 50568bd43, `resolve`
 * only. Verbatim: the bare-specifier exact match that hung on CI.
 */
const PRE_FIX_HYDRATE_HOOK = `const MARKER = 'collab-hydrate-gate-hook:';
const TARGET = '@/lib/collab/geometry-sync';

export async function resolve(specifier, context, nextResolve) {
  if (specifier === TARGET) {
    const real = await nextResolve(specifier, context);
    return { url: MARKER + real.url, shortCircuit: true, format: 'module' };
  }
  return nextResolve(specifier, context);
}
`;

/** The same file's `resolve` @ 73571eb46 — the fix that made it fire on CI's node. */
const FIXED_HYDRATE_HOOK = `const MARKER = 'collab-hydrate-gate-hook:';
const TARGET = '@/lib/collab/geometry-sync';
const GEOMETRY_SYNC_ENTRY = /\\/lib\\/collab\\/geometry-sync\\.tsx?$/;

export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.startsWith(MARKER)) return nextResolve(specifier, context);
  const real = await nextResolve(specifier, context);
  if (specifier === TARGET || GEOMETRY_SYNC_ENTRY.test(real.url.split('?')[0])) {
    return { url: MARKER + real.url, shortCircuit: true, format: 'module' };
  }
  return real;
}
`;

/** Writes `{ relPath: contents }` into a fresh temp tree and runs the checker on it. */
function runOn(tree, { mutate } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'loader-hook-specifier-match-'));
  try {
    for (const [rel, content] of Object.entries(tree)) {
      const abs = join(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      if (content !== null) writeFileSync(abs, content);
    }
    if (mutate) mutate(dir);
    const r = spawnSync(process.execPath, [CHECKER, '--root', dir], { encoding: 'utf8' });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A chmod-000 fixture can defeat removal on some filesystems; the temp dir
      // is the OS's problem at that point, not this suite's.
    }
  }
}

/** Minimum a tree needs so the search-root and empty-tree guards are not the ones firing. */
const BALLAST = {
  'packages/keep/index.ts': 'export const keep = 1;\n',
  'scripts/keep.mjs': 'export const keep = 1;\n',
};

// ── The real tree ───────────────────────────────────────────────────────────

test('the real repository passes, with non-zero counts in the success line', () => {
  const r = spawnSync(process.execPath, [CHECKER, '--root', ROOT], { encoding: 'utf8' });
  const out = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 0, out);
  const m = /check-loader-hook-specifier-match: OK \((\d+) files scanned, (\d+) loader hook file\(s\), (\d+) resolve hook\(s\), (\d+) condition\(s\)/.exec(out);
  assert.ok(m, `success line not recognised:\n${out}`);
  const [, files, hookFiles, resolveHooks, conditions] = m.map(Number);
  // Floors, not equalities: a new hook should not fail this suite, a vanished
  // one should. Today the repo has 2 hook files (collab-session-race-hook.mjs
  // and vite-module-hooks-impl.mjs) with 2 resolve hooks and 6 conditions.
  assert.ok(files > 100, `only ${files} files scanned — the walk stopped matching`);
  assert.ok(hookFiles >= 2, `only ${hookFiles} loader hook file(s) found, expected at least 2`);
  assert.ok(resolveHooks >= 2, `only ${resolveHooks} resolve hook(s) found, expected at least 2`);
  assert.ok(conditions >= 6, `only ${conditions} condition(s) analysed, expected at least 6`);
});

// ── RED: the historical pre-fix hook ────────────────────────────────────────

test('RED: the pre-fix collab-hydrate-gate-hook (50568bd43) is flagged', () => {
  const { status, out } = runOn({ ...BALLAST, [HOOK_REL]: PRE_FIX_HYDRATE_HOOK });
  assert.equal(status, 1, out);
  assert.match(out, /collab-hydrate-gate-hook\.mjs:4: `resolve` can only match a bare specifier/);
  assert.match(out, /matches only `@\/lib\/collab\/geometry-sync`/);
});

test('the fixed collab-hydrate-gate-hook (73571eb46) passes', () => {
  const { status, out } = runOn({ ...BALLAST, [HOOK_REL]: FIXED_HYDRATE_HOOK });
  assert.equal(status, 0, out);
  assert.match(out, /1 loader hook file\(s\), 1 resolve hook\(s\)/);
});

test('a correct hook in the same tree does not excuse the pre-fix one', () => {
  // The counts are repo-wide, so "some url-capable arm exists somewhere" must
  // not be what clears a hook. Both hooks present; only the pre-fix one is named.
  const { status, out } = runOn({
    ...BALLAST,
    [HOOK_REL]: PRE_FIX_HYDRATE_HOOK,
    'apps/viewer/src/test/collab-session-race-hook.mjs': FIXED_HYDRATE_HOOK,
  });
  assert.equal(status, 1, out);
  assert.match(out, /collab-hydrate-gate-hook\.mjs:4: `resolve` can only match a bare specifier/);
  assert.doesNotMatch(out, /collab-session-race-hook\.mjs:\d+: `resolve` can only match/);
});

// ── The classifier's edges ──────────────────────────────────────────────────

test('a scheme-carrying specifier is not bare-only: `node:` is never rewritten', () => {
  const hook = `export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'node:fs') {
    return { url: 'node:fs', shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`;
  const { status, out } = runOn({ ...BALLAST, 'apps/x/hook.mjs': hook });
  assert.equal(status, 0, out);
  assert.match(out, /0 bare-specifier arm\(s\)/);
});

test('a virtual-prefix hook is not flagged: it has no exact-equality arm to be dead', () => {
  // `vite-module-hooks-impl.mjs`'s `~icons/` shape. A prefix match on a bare
  // specifier is not URL-capable either, but a virtual specifier Node has never
  // heard of cannot be pre-resolved, so flagging it would be a false positive.
  const hook = `export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('~icons/')) {
    return { url: 'file:///stub.js', shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`;
  const { status, out } = runOn({ ...BALLAST, 'apps/x/hook.mjs': hook });
  assert.equal(status, 0, out);
});

test('a bare-only arm is excused by a suffix arm in the same hook — the recorded per-arm gap', () => {
  // Pins limitation 1 in the checker's header rather than wishing it away: this
  // is `vite-module-hooks-impl.mjs`'s real shape, and it passes. If the rule is
  // ever tightened to per-arm, this test is the one that must be rewritten, in
  // the same commit as the fix to that file.
  const hook = `export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'cesium') {
    return { url: 'file:///stub.js', shortCircuit: true };
  }
  if (specifier.endsWith('.css')) {
    return { url: 'file:///css.js', shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`;
  const { status, out } = runOn({ ...BALLAST, 'apps/x/hook.mjs': hook });
  assert.equal(status, 0, out);
  assert.match(out, /1 bare-specifier arm\(s\)/);
});

test('a hook file embedded as a STRING fixture is data, not a hook', () => {
  // This suite is itself such a file. Without the string-blanked view the guard
  // would report its own fixtures and every test that quotes a hook.
  const fixture = `export const SOURCE = ${JSON.stringify(PRE_FIX_HYDRATE_HOOK)};\n`;
  const { status, out } = runOn({ ...BALLAST, 'apps/x/fixture.mjs': fixture });
  assert.equal(status, 1, out);
  // Not "can only match a bare specifier" — it is the no-hooks-found tooth that
  // must fire, proving the fixture was not counted as a hook.
  assert.match(out, /no loader hooks found/);
});

// ── Anti-vacuity: every way to scan nothing is an error ─────────────────────

test('vacuity: a root with none of the search roots fails', () => {
  const { status, out } = runOn({ 'somewhere/else.mjs': 'export const x = 1;\n' });
  assert.equal(status, 1, out);
  assert.match(out, /search roots missing/);
});

test('vacuity: search roots that contain no source files fail', () => {
  const { status, out } = runOn({}, {
    mutate: (dir) => {
      mkdirSync(join(dir, 'apps'), { recursive: true });
      mkdirSync(join(dir, 'packages'), { recursive: true });
      mkdirSync(join(dir, 'scripts'), { recursive: true });
    },
  });
  assert.equal(status, 1, out);
  assert.match(out, /zero source files/);
});

test('vacuity: a tree with source files but no loader hook fails', () => {
  const { status, out } = runOn({ ...BALLAST, 'apps/x/plain.mjs': 'export const x = 1;\n' });
  assert.equal(status, 1, out);
  assert.match(out, /no loader hooks found/);
  assert.match(out, /file\(s\) were scanned/);
});

test('vacuity: an unreadable file fails rather than being skipped', () => {
  const { status, out } = runOn(
    { ...BALLAST, 'apps/x/hook.mjs': PRE_FIX_HYDRATE_HOOK, 'apps/x/locked.mjs': 'export const x = 1;\n' },
    { mutate: (dir) => chmodSync(join(dir, 'apps/x/locked.mjs'), 0o000) },
  );
  assert.equal(status, 1, out);
  assert.match(out, /unreadable file apps\/x\/locked\.mjs/);
});

test('vacuity: a hook whose `resolve` cannot be located fails', () => {
  const hook = `const table = { resolve: async (specifier, context, nextResolve) => nextResolve(specifier, context) };
export const { resolve } = table;
`;
  const { status, out } = runOn({ ...BALLAST, 'apps/x/hook.mjs': hook });
  assert.equal(status, 1, out);
  assert.match(out, /no `resolve` hook could be located/);
});

test('vacuity: a `resolve` with no `if (...)` condition fails closed', () => {
  // The ternary shape, which this guard cannot classify. It must error, not pass:
  // "no bare-only arm found" is true of a hook whose arms were never read.
  const hook = `const TARGET = '@/lib/collab/geometry-sync';
export async function resolve(specifier, context, nextResolve) {
  return specifier === TARGET
    ? { url: 'x:' + specifier, shortCircuit: true }
    : nextResolve(specifier, context);
}
`;
  const { status, out } = runOn({ ...BALLAST, 'apps/x/hook.mjs': hook });
  assert.equal(status, 1, out);
  assert.match(out, /has no `if \(\.\.\.\)` match condition/);
});

test('vacuity: a `resolve` with no usable first parameter fails', () => {
  const hook = `export async function resolve({ specifier }, context, nextResolve) {
  if (specifier === 'x') return { url: 'file:///a.js', shortCircuit: true };
  return nextResolve(specifier, context);
}
`;
  const { status, out } = runOn({ ...BALLAST, 'apps/x/hook.mjs': hook });
  assert.equal(status, 1, out);
  assert.match(out, /no usable first parameter/);
});
