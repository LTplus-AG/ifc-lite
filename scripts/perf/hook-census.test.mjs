// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// #6957: the static hook census follows a path's import graph and counts hook
// call sites and store subscriptions in the component/hook modules it reaches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { censusFrom, hookCensus } from './hook-census.mjs';

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'hook-census-'));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}

test('#6957 counts hooks and subscriptions across the reachable component and hook modules', () => {
  const root = fixture({
    'Panel.tsx': `
      import React, { useMemo } from 'react';
      import { Row } from './Row.js';
      import { useSelection } from '@/hooks/useSelection';
      import { format } from './format';
      import type { Unused } from './TypesOnly';
      const Lazy = React.lazy(() => import('./LazyPane'));
      export function Panel() {
        const a = useViewerStore((s) => s.a);
        const all = useViewerStore();
        const m = useMemo(() => a, [a]);
        const [x] = React.useState(0);
        useSelection();
        return null;
      }`,
    'Row.tsx': `export function Row() { useViewerStore((s) => s.b); return null; }`,
    'LazyPane.tsx': `export default function LazyPane() { useEffectOnce(); return null; }`,
    'hooks/useSelection.ts': `export function useSelection() { return useViewerStore((s) => s.sel); }`,
    // A plain helper: followed for its imports, but its own calls are not component hooks.
    'format.ts': `import { Deep } from './Deep'; export const format = () => useNotAHook();`,
    'Deep.tsx': `export function Deep() { useState(); return null; }`,
    'TypesOnly.tsx': `export type Unused = number; useNeverReached();`,
    'Panel.test.tsx': `useInTestOnly();`,
  });
  try {
    const c = censusFrom(join(root, 'Panel.tsx'), root);
    // Panel: useViewerStore x2, useMemo, React.useState, useSelection = 5 (+1 lazy() is not a hook).
    // Row 1, LazyPane 1, useSelection.ts 1, Deep 1 -> 9; format.ts and the type-only import are excluded.
    assert.equal(c.hooks, 9);
    assert.equal(c.modules, 5);
    assert.equal(c.storeSubscriptions, 3);
    assert.equal(c.wholeStoreSubscriptions, 1);
    assert.deepEqual(c.topModules[0], { file: 'Panel.tsx', hooks: 5, storeSubscriptions: 1, wholeStoreSubscriptions: 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('#6957 the four viewer paths resolve to real entry modules', () => {
  const census = hookCensus();
  for (const name of ['viewport', 'properties', 'hierarchy', 'streaming']) {
    assert.ok(census[name].modules > 0 && census[name].hooks > 0, `${name}: ${JSON.stringify(census[name])}`);
  }
});

test('#6957 --top 0 yields totals with no top modules; a garbled --top is rejected', () => {
  const cli = new URL('./hook-census.mjs', import.meta.url).pathname;
  const zero = spawnSync(process.execPath, [cli, '--json', '--top', '0'], { encoding: 'utf8' });
  assert.equal(zero.status, 0, zero.stderr);
  for (const path of Object.values(JSON.parse(zero.stdout))) assert.deepEqual(path.topModules, [], '--top 0 must not fall back to the default 10');
  const bad = spawnSync(process.execPath, [cli, '--top', 'lots'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--top expects a non-negative integer/);
});
