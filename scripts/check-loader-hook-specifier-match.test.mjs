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
 * that matched a tsconfig-aliased specifier by bare equality alone. Per
 * 73571eb46's own reproduction, it hung
 * `collabSlice.leave-after-reconstruct.test.ts` 3 of 3 on Node 22.23.2 and
 * passed on 22.13.1. `FIXED_HYDRATE_HOOK` is the same file after 73571eb46. The
 * two differ only in the `resolve` arm, so a rule that reds the first and greens
 * the second is measuring the thing the incident was about.
 *
 * The rule turns on ALIAS COVERAGE, so the suite pins both sides of it. A bare
 * arm on a non-aliased specifier (`cesium`, verified working on CI — see the
 * checker's header for the run and job ids) must stay GREEN; the identical hook
 * must go RED as soon as a `paths` entry claims that same specifier. Those two
 * tests are a matched pair, and if they ever agree the alias table has stopped
 * being what decides.
 *
 * The other half of the suite is anti-vacuity: every way this guard could scan
 * nothing and pass — a missing search root, an empty tree, no hooks, an empty or
 * unparseable alias table, an unreadable file, a `resolve` with no locatable
 * condition — is asserted to be a non-zero exit with a named reason, because a
 * guard that finds nothing to guard passes forever.
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

/**
 * The alias table a fixture tree needs, mirroring `apps/viewer/tsconfig.json`:
 * the `@/*` wildcard that claims `@/lib/collab/geometry-sync`, and the exact
 * `@ifc-lite/collab` key. Both historical incidents are one of these two shapes.
 */
const TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      baseUrl: '.',
      paths: { '@/*': ['./src/*'], '@ifc-lite/collab': ['../../packages/collab/src'] },
    },
  },
  null,
  2,
);

/** Minimum a tree needs so the search-root, empty-tree and alias-table guards are not the ones firing. */
const BALLAST = {
  'packages/keep/index.ts': 'export const keep = 1;\n',
  'scripts/keep.mjs': 'export const keep = 1;\n',
  'apps/viewer/tsconfig.json': TSCONFIG,
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
  assert.match(out, /collab-hydrate-gate-hook\.mjs:4: `resolve` matches an aliased specifier by equality only/);
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
  assert.match(out, /collab-hydrate-gate-hook\.mjs:4: `resolve` matches an aliased specifier by equality only/);
  assert.doesNotMatch(out, /collab-session-race-hook\.mjs:\d+: `resolve` matches an aliased specifier/);
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

/**
 * `vite-module-hooks-impl.mjs`'s real shape. `cesium` is a bare-only arm, and it
 * is VERIFIED WORKING: CI run 32532771710, job 96928471894 ("Viewer tests
 * (shard 3)") on `main`, Node v22.23.2, passes
 * `CesiumOverlay — state writes after the init effect is torn down (#2685)`,
 * which can only pass if this arm fires. So it must stay green — and, since the
 * rule is now per-arm, it must stay green on its own merits rather than by
 * being excused by the `.css` arm beside it.
 */
const CESIUM_SHAPED_HOOK = `export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'cesium') {
    return { url: 'file:///stub.js', shortCircuit: true };
  }
  if (specifier.endsWith('.css')) {
    return { url: 'file:///css.js', shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`;

test('a bare-only arm on a NON-aliased specifier is not flagged: it is not dead', () => {
  const { status, out } = runOn({ ...BALLAST, 'apps/x/hook.mjs': CESIUM_SHAPED_HOOK });
  assert.equal(status, 0, out);
  // Counted as bare, but cleared as not alias-covered — the discrimination this
  // rule turns on, visible in the success line rather than merely believed.
  assert.match(out, /1 bare-specifier arm\(s\), 0 alias-covered/);
});

test('CONTROL: the same hook IS flagged once a `paths` entry claims that specifier', () => {
  // The lexical twin of the runtime control in the header: one specifier, one
  // spelling, one tsconfig entry's difference. If this test and the one above
  // ever agree, the alias table has stopped being what decides.
  const claimed = JSON.stringify({ compilerOptions: { paths: { cesium: ['./src/cesium'] } } });
  const { status, out } = runOn({
    ...BALLAST,
    'apps/viewer/tsconfig.json': claimed,
    'apps/x/hook.mjs': CESIUM_SHAPED_HOOK,
  });
  assert.equal(status, 1, out);
  assert.match(out, /matches only `cesium`, which tsconfig `paths` claims via `cesium`/);
});

test('per-arm: a dead alias arm is NOT excused by a url-capable arm beside it', () => {
  // The gap the previous revision recorded as tolerated. A hook whose FIRST arm
  // is an alias equality still hangs on that specifier no matter what its other
  // arms match, so the url-capable escape must be per-condition, not per-hook.
  const hook = `const TARGET = '@ifc-lite/collab';
export async function resolve(specifier, context, nextResolve) {
  if (specifier === TARGET) {
    return { url: 'file:///stub.js', shortCircuit: true };
  }
  if (specifier.endsWith('.css')) {
    return { url: 'file:///css.js', shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`;
  const { status, out } = runOn({ ...BALLAST, 'apps/x/hook.mjs': hook });
  assert.equal(status, 1, out);
  assert.match(out, /matches only `@ifc-lite\/collab`, which tsconfig `paths` claims via `@ifc-lite\/collab`/);
});

test('a dead alias arm rescued by an `||` in the SAME condition passes', () => {
  // The remedy both real fixes used, reduced to its essentials. This is the
  // reason the escape is per-condition rather than per-arm-token: `specifier ===
  // TARGET || <url test>` is one arm with a live fallback, not a dead one.
  const hook = `const TARGET = '@ifc-lite/collab';
export async function resolve(specifier, context, nextResolve) {
  const real = await nextResolve(specifier, context);
  if (specifier === TARGET || real.url.endsWith('/collab/src/index.ts')) {
    return { url: 'file:///stub.js', shortCircuit: true };
  }
  return real;
}
`;
  const { status, out } = runOn({ ...BALLAST, 'apps/x/hook.mjs': hook });
  assert.equal(status, 0, out);
  assert.match(out, /1 bare-specifier arm\(s\), 1 alias-covered/);
});

test('an `&&` does NOT rescue a dead alias arm: every conjunct must hold', () => {
  // The mirror image of the `||` test above, and the reason the escape reads the
  // condition's boolean STRUCTURE rather than scanning it flat. `specifier ===
  // ALIASED || <url test>` matches through the right-hand side; `specifier ===
  // ALIASED && <url test>` can never match at all, because the left-hand side is
  // exactly the equality tsx's synchronous hook makes unreachable. A flat "does
  // this condition mention anything url-capable" test clears both, which is a
  // hole big enough to hide the next incident in.
  const hook = `const TARGET = '@ifc-lite/collab';
export async function resolve(specifier, context, nextResolve) {
  const real = await nextResolve(specifier, context);
  if (specifier === TARGET && real.url.endsWith('/collab/src/index.ts')) {
    return { url: 'file:///stub.js', shortCircuit: true };
  }
  return real;
}
`;
  const { status, out } = runOn({ ...BALLAST, 'apps/x/hook.mjs': hook });
  assert.equal(status, 1, out);
  assert.match(out, /matches only `@ifc-lite\/collab`, which tsconfig `paths` claims via `@ifc-lite\/collab`/);
});

test('an `&&` guard around a live `||` remedy still passes', () => {
  // The false positive the `&&` rule must not produce, and the shape the
  // checker's own header recommends: the self-wrapping guard on
  // `context.parentURL` is ANDed onto a remedy that is live through its `||`.
  // Structure, not string matching, is what tells this apart from the test
  // above — both contain `===`, `&&` and a url test.
  const hook = `const TARGET = '@ifc-lite/collab';
const MARKER = 'stub:';
export async function resolve(specifier, context, nextResolve) {
  const real = await nextResolve(specifier, context);
  if ((specifier === TARGET || real.url.endsWith('/collab/src/index.ts')) && !context.parentURL?.startsWith(MARKER)) {
    return { url: 'file:///stub.js', shortCircuit: true };
  }
  return real;
}
`;
  const { status, out } = runOn({ ...BALLAST, 'apps/x/hook.mjs': hook });
  assert.equal(status, 0, out);
});

// ── The inequality spelling, whose sense comes from the BRANCH ──────────────

/**
 * `if (specifier !== ALIASED) return nextResolve(...)` is the same deadness as
 * the equality form wearing a different operator: the early return hands every
 * OTHER specifier straight on, so the hook's real work sits below the guard and
 * runs only when the specifier IS the aliased one — which, measured, it never
 * is. It is also the more idiomatic hook shape of the two ("not mine, pass it
 * through"), so leaving it invisible would leave the likelier spelling of the
 * next incident unguarded.
 *
 * The next three tests are a matched TRIPLE, and the point is that the operator
 * alone does not decide. Same condition, same specifier, same alias table:
 * flagged when the branch passes through, green when the branch does the
 * wrapping, green when the specifier is not alias-covered.
 */
const INEQUALITY_GUARD_HOOK = `const TARGET = '@ifc-lite/collab';
export async function resolve(specifier, context, nextResolve) {
  if (specifier !== TARGET) return nextResolve(specifier, context);
  return { url: 'file:///stub.js', shortCircuit: true };
}
`;

test('RED: an inequality early-return on an aliased specifier is flagged', () => {
  const { status, out } = runOn({ ...BALLAST, 'apps/x/hook.mjs': INEQUALITY_GUARD_HOOK });
  assert.equal(status, 1, out);
  assert.match(out, /`resolve` passes everything through on an inequality that always holds/);
  assert.match(out, /returns early unless the specifier is `@ifc-lite\/collab`/);
});

test('CONTROL: the same inequality is NOT flagged when the branch does the wrapping', () => {
  // The half of the rule that is easy to get wrong. Here the always-true
  // condition guards the WRAPPING, not a pass-through, so nothing below it is
  // load-bearing and nothing is dead. A gate that reds this reds a working hook,
  // and a gate that reds working hooks gets disabled.
  const hook = `const TARGET = '@ifc-lite/collab';
export async function resolve(specifier, context, nextResolve) {
  if (specifier !== TARGET) {
    return { url: 'file:///stub.js', shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`;
  const { status, out } = runOn({ ...BALLAST, 'apps/x/hook.mjs': hook });
  assert.equal(status, 0, out);
  assert.match(out, /1 bare-specifier arm\(s\), 1 alias-covered/);
});

test('an inequality early-return on a NON-aliased specifier is not flagged', () => {
  // The alias table is still what decides, in this direction too: `cesium` is
  // reached, so the guard's fall-through is reachable and nothing is dead.
  const hook = `export async function resolve(specifier, context, nextResolve) {
  if (specifier !== 'cesium') return nextResolve(specifier, context);
  return { url: 'file:///stub.js', shortCircuit: true };
}
`;
  const { status, out } = runOn({ ...BALLAST, 'apps/x/hook.mjs': hook });
  assert.equal(status, 0, out);
  assert.match(out, /1 bare-specifier arm\(s\), 0 alias-covered/);
});

test('`!(specifier === ALIASED)` reads exactly as `!==` does, in both directions', () => {
  // Two claims in one, because they are one claim: the negation is understood
  // structurally rather than string-matched. The pass-through spelling is
  // flagged like its `!==` twin — and the wrapping spelling is NOT, which
  // retires a false positive an earlier revision had on this exact shape,
  // where the inner equality was read flat and the `!` around it ignored.
  const guard = `const TARGET = '@ifc-lite/collab';
export async function resolve(specifier, context, nextResolve) {
  if (!(specifier === TARGET)) return nextResolve(specifier, context);
  return { url: 'file:///stub.js', shortCircuit: true };
}
`;
  const wrapping = `const TARGET = '@ifc-lite/collab';
export async function resolve(specifier, context, nextResolve) {
  if (!(specifier === TARGET)) {
    return { url: 'file:///stub.js', shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`;
  const red = runOn({ ...BALLAST, 'apps/x/hook.mjs': guard });
  assert.equal(red.status, 1, red.out);
  assert.match(red.out, /returns early unless the specifier is `@ifc-lite\/collab`/);

  const green = runOn({ ...BALLAST, 'apps/x/hook.mjs': wrapping });
  assert.equal(green.status, 0, green.out);
});

test('an inequality guard with a live url conjunct is not flagged', () => {
  // The remedy in negated dress, and the reason the analysis carries BOTH
  // directions through the `||`/`&&` structure instead of just inverting a
  // verdict. The fall-through runs when `specifier === TARGET` OR the url test
  // holds, and the second half is reachable, so nothing below is dead.
  const hook = `const TARGET = '@ifc-lite/collab';
export async function resolve(specifier, context, nextResolve) {
  const real = await nextResolve(specifier, context);
  if (specifier !== TARGET && !real.url.endsWith('/collab/src/index.ts')) return nextResolve(specifier, context);
  return { url: 'file:///stub.js', shortCircuit: true };
}
`;
  const { status, out } = runOn({ ...BALLAST, 'apps/x/hook.mjs': hook });
  assert.equal(status, 0, out);
});

test('a url signal inside a TERNARY leaf still clears the arm', () => {
  // The one shape that reaches the leaf-level url escape. After the `||`/`&&`
  // split no leaf can hold both an equality and a url signal EXCEPT through a
  // ternary or a nested call, so without this fixture that escape is untested
  // code in a gate. VERIFIED BY MUTATION: delete the escape and this test is the
  // only one in the suite that reds — and it reds on a hook that does fire,
  // through the ternary's consequent, which is exactly the false positive the
  // escape exists to prevent.
  const hook = `const TARGET = '@ifc-lite/collab';
export async function resolve(specifier, context, nextResolve) {
  const real = await nextResolve(specifier, context);
  if (context.parentURL ? real.url.endsWith('/collab/src/index.ts') : specifier === TARGET) {
    return { url: 'file:///stub.js', shortCircuit: true };
  }
  return real;
}
`;
  const { status, out } = runOn({ ...BALLAST, 'apps/x/hook.mjs': hook });
  assert.equal(status, 0, out);
  assert.match(out, /1 bare-specifier arm\(s\), 1 alias-covered/);
});

test('alias coverage matches a `@/*` wildcard, not just an exact key', () => {
  // `@/lib/collab/geometry-sync` is claimed by `@/*`, which is how incident one
  // was dead. Exact-key-only matching would miss it, so pin the wildcard arm.
  const hook = `export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@/lib/deep/nested/thing') {
    return { url: 'file:///stub.js', shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`;
  const { status, out } = runOn({ ...BALLAST, 'apps/x/hook.mjs': hook });
  assert.equal(status, 1, out);
  assert.match(out, /claims via `@\/\*`/);
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

test('vacuity: a tree with no tsconfig `paths` aliases fails', () => {
  // The alias table is the whole predicate now. An empty one would clear every
  // bare arm in the repo and the success line would still read OK, so losing it
  // must be an error rather than a quiet universal pass.
  const { status, out } = runOn({
    'packages/keep/index.ts': 'export const keep = 1;\n',
    'scripts/keep.mjs': 'export const keep = 1;\n',
    'apps/x/hook.mjs': PRE_FIX_HYDRATE_HOOK,
  });
  assert.equal(status, 1, out);
  assert.match(out, /no tsconfig `paths` aliases found/);
});

test('vacuity: an unparseable tsconfig fails rather than contributing nothing', () => {
  const { status, out } = runOn({
    ...BALLAST,
    'apps/viewer/tsconfig.json': '{ "compilerOptions": { "paths": { oops } } }',
    'apps/x/hook.mjs': PRE_FIX_HYDRATE_HOOK,
  });
  assert.equal(status, 1, out);
  assert.match(out, /unparseable tsconfig apps\/viewer\/tsconfig\.json/);
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
