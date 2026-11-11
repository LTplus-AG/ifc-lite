/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The build gate that keeps the structural write path out of the viewer's
 * startup graph (`scripts/check-structural-writes-lazy.mjs`, run by the viewer
 * `build` script, #9668), exercised on synthetic dists so each refusal is
 * shown to fire. The real build is the other half: the gate fails on a build
 * where the store adapter imports `createStructuralStoreBackend` statically.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkStructuralWritesLazy, STRUCTURAL_WRITE_SIGNATURES } from '../../../scripts/check-structural-writes-lazy.mjs';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function dist(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'structural-lazy-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'),
    '<html><head><script type="module" src="/assets/main.js"></script><link rel="modulepreload" href="/assets/ui.js"></head></html>');
  for (const [name, code] of Object.entries(files)) writeFileSync(join(dir, 'assets', name), code);
  return dir;
}

/** Minified builder code: each signature as the error-message prefix it is in the real bundle. */
const BUILDERS = STRUCTURAL_WRITE_SIGNATURES.map((signature, i) => `function b${i}(k){throw new Error(\`${signature} \`+k)}`).join(';');

describe('checkStructuralWritesLazy', () => {
  it('passes when the builders are only reachable through a dynamic import', async () => {
    const dir = dist({
      'main.js': 'import "./ui.js"; const label="addStructuralCurveMember"; import("./structural.js");',
      'ui.js': 'export const x=1;',
      'structural.js': BUILDERS,
    });
    const { eager, lazy } = await checkStructuralWritesLazy(dir);
    assert.deepEqual(eager, ['assets/main.js', 'assets/ui.js']);
    assert.deepEqual(lazy, ['assets/structural.js']);
  });

  it('refuses builder code reached by a static import from the entry', async () => {
    const dir = dist({
      'main.js': 'import { s } from "./shared.js";',
      'ui.js': 'export const x=1;',
      'shared.js': `export const s=1;${BUILDERS}`,
    });
    await assert.rejects(checkStructuralWritesLazy(dir), /Startup chunk assets\/shared\.js contains addStructuralCurveMemberToStore:/);
  });

  it('refuses builder code in a modulepreloaded chunk', async () => {
    const dir = dist({ 'main.js': 'export {}', 'ui.js': 'throw new Error(`bim.store structural authoring: schema`);', 'structural.js': BUILDERS });
    await assert.rejects(checkStructuralWritesLazy(dir), /Startup chunk assets\/ui\.js contains bim\.store structural authoring:/);
  });

  it('refuses a build with no structural write code at all, so it cannot pass vacuously', async () => {
    const dir = dist({ 'main.js': 'import("./other.js");', 'ui.js': 'export {}', 'other.js': 'export const y=2;' });
    await assert.rejects(checkStructuralWritesLazy(dir), /proves nothing/);
  });
});
