/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkStoreImportCycles, findStoreImportCycles } from './check-store-import-cycles.mjs';

const fixtures = [];
after(() => { for (const root of fixtures) rmSync(root, { recursive: true, force: true }); });

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'store-import-cycle-'));
  fixtures.push(root);
  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, contents);
  }
  return root;
}

const entry = 'apps/viewer/src/store/index.ts';

describe('viewer store import-cycle guard', () => {
  it('reports reachable value imports back through the alias and relative entry path', () => {
    const root = fixture({
      [entry]: "import './slices/alias.js';\nimport './slices/relative.js';\n",
      'apps/viewer/src/store/slices/alias.ts': "import { useViewerStore } from '@/store';\n",
      'apps/viewer/src/store/slices/relative.ts': "import { useViewerStore } from '../index.js';\n",
    });
    const { newOffenders } = checkStoreImportCycles(root);
    assert.deepEqual(newOffenders.map((path) => path.slice(root.length + 1)), [
      'apps/viewer/src/store/slices/alias.ts', 'apps/viewer/src/store/slices/relative.ts',
    ]);
  });

  it('passes a reachable tree without an import back into the store entry', () => {
    const root = fixture({
      [entry]: "import './slices/child.js';\n",
      'apps/viewer/src/store/slices/child.ts': "import { value } from './value.js'; export { value };\n",
      'apps/viewer/src/store/slices/value.ts': 'export const value = 1;\n',
    });
    assert.deepEqual(checkStoreImportCycles(root).newOffenders, []);
  });

  it('ignores import type edges while walking the graph', () => {
    const root = fixture({
      [entry]: "import type { StoreShape } from './slices/type-only.js';\n",
      'apps/viewer/src/store/slices/type-only.ts': "import { useViewerStore } from '@/store';\n",
    });
    assert.deepEqual(findStoreImportCycles(root).reachable.map((path) => path.slice(root.length + 1)), [entry]);
    assert.deepEqual(findStoreImportCycles(root).offenders, []);
  });

  it('reports an allowlist row whose module no longer imports the store entry as stale', () => {
    const root = fixture({
      [entry]: "import './slices/fixed.js';\nimport './slices/still.js';\n",
      'apps/viewer/src/store/slices/fixed.ts': 'export const fixed = 1;\n',
      'apps/viewer/src/store/slices/still.ts': "import { useViewerStore } from '@/store';\n",
    });
    const result = checkStoreImportCycles(root, ['apps/viewer/src/store/slices/fixed.ts', 'apps/viewer/src/store/slices/still.ts']);
    assert.deepEqual(result.newOffenders, []);
    assert.deepEqual(result.staleRows.map((path) => path.slice(root.length + 1)), ['apps/viewer/src/store/slices/fixed.ts']);
  });

  it('passes the real viewer store graph, with no stale allowlist rows', () => {
    const result = checkStoreImportCycles();
    assert.deepEqual(result.newOffenders, []);
    assert.deepEqual(result.staleRows, []);
  });

  it('has no actual store-entry import-cycle offenders', () => {
    assert.deepEqual(findStoreImportCycles().offenders, []);
  });
});
