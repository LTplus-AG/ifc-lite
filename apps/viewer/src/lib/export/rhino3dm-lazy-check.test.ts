/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The build gate that keeps rhino3dm out of the viewer's startup graph
 * (`scripts/check-rhino3dm-lazy.mjs`, run by the viewer `build` script),
 * exercised on synthetic dists so each refusal is shown to fire.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkRhino3dmLazy } from '../../../scripts/check-rhino3dm-lazy.mjs';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function dist(files: Record<string, string>, head = ''): string {
  const dir = mkdtempSync(join(tmpdir(), 'rhino-lazy-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'),
    `<html><head><script type="module" src="/assets/main.js"></script>${head}</head></html>`);
  for (const [name, code] of Object.entries(files)) writeFileSync(join(dir, 'assets', name), code);
  return dir;
}

const LAZY_RUNTIME = 'var w=new URL("rhino3dm.wasm",import.meta.url);';
const LAZY_SCENE = 'var s=new URL("assets/ifc-lite-rhino_bg-abc.wasm",import.meta.url);';

describe('checkRhino3dmLazy', () => {
  it('passes when rhino3dm is only reachable through a dynamic import', async () => {
    const dir = dist({
      'main.js': 'import "./ui.js"; const versions=[{name:"@ifc-lite/rhino3dm"}]; import("./rhino.js"); import("./scene.js");',
      'ui.js': 'export const x=1;',
      'rhino.js': LAZY_RUNTIME,
      'scene.js': LAZY_SCENE,
    });
    const { eager, lazy } = await checkRhino3dmLazy(dir);
    assert.deepEqual(eager.sort(), ['assets/main.js', 'assets/ui.js']);
    assert.deepEqual(lazy, ['assets/rhino.js', 'assets/scene.js']);
  });

  it('refuses rhino3dm code reached by a static import from the entry', async () => {
    const dir = dist({
      'main.js': 'import { w } from "./ui.js";',
      'ui.js': 'export { w } from "./rhino.js";',
      'rhino.js': 'const o=new r.File3dmWriteOptions();',
    });
    await assert.rejects(checkRhino3dmLazy(dir), /Startup chunk assets\/rhino\.js contains File3dmWriteOptions/);
  });

  it('refuses the Rhino scene wasm reached by a static import, or preloaded', async () => {
    const eager = dist({ 'main.js': 'import "./scene.js"; import("./rhino.js");', 'scene.js': 'w.__wbg_rhinoscenejs_free(1);', 'rhino.js': LAZY_RUNTIME });
    await assert.rejects(checkRhino3dmLazy(eager), /Startup chunk assets\/scene\.js contains rhinoscenejs_free/);
    const preloaded = dist({ 'main.js': 'import("./rhino.js"); import("./scene.js");', 'rhino.js': LAZY_RUNTIME, 'scene.js': LAZY_SCENE },
      '<link rel="preload" href="/assets/ifc-lite-rhino_bg-abc.wasm">');
    await assert.rejects(checkRhino3dmLazy(preloaded), /preloads the Rhino scene wasm/);
  });

  it('refuses a build that lost either payload, which would pass vacuously', async () => {
    await assert.rejects(checkRhino3dmLazy(dist({ 'main.js': 'import("./rhino.js")', 'rhino.js': LAZY_RUNTIME })), /carries the Rhino scene wasm code/);
    await assert.rejects(checkRhino3dmLazy(dist({ 'main.js': 'import("./scene.js")', 'scene.js': LAZY_SCENE })), /carries the rhino3dm wasm code/);
  });

  it('refuses a modulepreloaded rhino3dm chunk and a preloaded wasm', async () => {
    const preloaded = dist({ 'main.js': 'import("./scene.js")', 'rhino.js': LAZY_RUNTIME, 'scene.js': LAZY_SCENE }, '<link rel="modulepreload" href="/assets/rhino.js">');
    await assert.rejects(checkRhino3dmLazy(preloaded), /Startup chunk assets\/rhino\.js/);
    const wasm = dist({ 'main.js': 'import("./rhino.js"); import("./scene.js");', 'rhino.js': LAZY_RUNTIME, 'scene.js': LAZY_SCENE }, '<link rel="preload" href="/assets/rhino3dm-abc.wasm">');
    await assert.rejects(checkRhino3dmLazy(wasm), /preloads the rhino3dm wasm/);
  });

  it('refuses a build with no rhino3dm at all, which would pass vacuously', async () => {
    await assert.rejects(checkRhino3dmLazy(dist({ 'main.js': '' })), /proves nothing/);
  });
});

describe('rhino3dm version pin', () => {
  it('the viewer resolves the same rhino3dm the adapter pins', () => {
    // The worker takes the wasm URL from the viewer's own rhino3dm, while the
    // adapter loads the JS from its own; a version skew would pair a loader
    // with the wrong wasm.
    const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    const viewer = read('../../../package.json').dependencies.rhino3dm;
    const adapter = read('../../../../../packages/rhino3dm/package.json').dependencies.rhino3dm;
    assert.equal(viewer, adapter);
  });
});
