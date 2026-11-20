/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as chunks from '../../vite-chunks';

type Group = { name: string; priority: number; includeDependenciesRecursively?: boolean; test: RegExp };

test('allowlist chunk groups claim exactly their existing members and leave deferred boundaries out', () => {
  const groups = chunks as Record<string, unknown>;
  const src = '/repo/apps/viewer/src/';
  const cases: Array<[string, string[]]> = [
    ['drawingShared', ['hooks/dxfReferencePlane.ts', 'hooks/useDxfUnderlay.ts?worker']],
    ['drawingLeaves', ['lib/drawing/export-native-drawing.ts']],
    // Dynamic-import paths (pdf.js, wasm), eager history, and the textured-product
    // family the Drawing panel's reference library imports.
    ['appearanceWorkflows', ['lib/appearance/appearance-native-pdf.ts', 'lib/appearance/pdf/browser-backend.ts',
      'lib/appearance/raster-calibration.ts', 'lib/appearance/plane-calibration.ts', 'lib/appearance/history.ts', 'lib/appearance/textured-product-command.ts']],
  ];
  const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  for (const [family, excluded] of cases) {
    const name = `${family}ChunkGroup`;
    const group = groups[name] as Group;
    const modules = groups[`${family}Modules`] as readonly string[];
    assert.ok(group && modules, name);
    assert.equal(group.includeDependenciesRecursively, false, name);
    assert.ok(group.priority > 0 && group.priority < 50, name);
    for (const module of modules) {
      const memberPath = resolve(srcDir, `${module}.ts`);
      // A renamed member silently drops out of its group and splits again.
      assert.ok(existsSync(memberPath), `${name}: ${module}.ts exists`);
      assert.ok(group.test.test(`${src}${module}.ts`), `${name} claims ${module}`);
    }
    for (const id of excluded) {
      assert.ok(existsSync(resolve(srcDir, id.replace(/\?.*$/, ''))), `${name}: excluded ${id} exists`);
      assert.equal(group.test.test(src + id), false, `${name} leaves ${id}`);
    }
  }
});
