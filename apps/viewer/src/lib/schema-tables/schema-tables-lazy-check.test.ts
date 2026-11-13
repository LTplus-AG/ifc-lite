/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The build gate that keeps eager schema-table constants out of the viewer's
 * startup chunks (`scripts/check-schema-tables-lazy.mjs`, run by the viewer
 * `build` script), exercised on synthetic dists so each refusal is shown to
 * fire. The marker text below is written by hand after what `eagerSchemaTable`
 * emits, not imported from the gate, so a changed marker fails here.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSchemaTablesLazy } from '../../../scripts/check-schema-tables-lazy.mjs';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function dist(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'schema-tables-lazy-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'),
    '<html><head><script type="module" src="/assets/main.js"></script><link rel="modulepreload" href="/assets/ui.js"></head></html>');
  for (const [name, code] of Object.entries(files)) writeFileSync(join(dir, 'assets', name), code);
  return dir;
}

// What a kept `export const ENTITIES_IFC4X3 = eagerSchemaTable(..., getEntitiesIfc4x3)` minifies to.
const KEPT = 'var t=e(`ifc-lite-eager-table:ENTITIES_IFC4X3`,n);';
// A getter alone (the startup path's form): the encoded string (it names its schema) and the decoder, no marker.
const GETTER_ONLY = 'let r;function n(){return r===void 0&&(r=d(`{"n":"IFC4_ADD2_TC1","s":["IfcWall"]}`)),r}';

describe('checkSchemaTablesLazy', () => {
  it('passes when every chunk only carries getters, and walks the static startup graph', async () => {
    const dir = dist({ 'main.js': `import "./ui.js";${GETTER_ONLY} import("./ids.js");`, 'ui.js': 'export const x=1;', 'ids.js': GETTER_ONLY });
    const { eager, lazyCount } = await checkSchemaTablesLazy(dir);
    assert.deepEqual(eager, ['assets/main.js', 'assets/ui.js']);
    assert.equal(lazyCount, 1);
  });

  // The entry calls import() at once, so ids.js is evaluated at boot although
  // no static import reaches it: a kept constant there must fail too.
  it('refuses an eager constant in a chunk the entry imports dynamically', async () => {
    const dir = dist({ 'main.js': `import "./ui.js";${GETTER_ONLY} import("./ids.js");`, 'ui.js': 'export const x=1;', 'ids.js': KEPT });
    await assert.rejects(checkSchemaTablesLazy(dir), /Chunk assets\/ids\.js \(loaded on demand\) contains ifc-lite-eager-table:ENTITIES_IFC4X3/);
  });

  it('refuses an eager constant in the entry chunk, naming it', async () => {
    const dir = dist({ 'main.js': KEPT, 'ui.js': 'export const x=1;', 'ids.js': KEPT });
    await assert.rejects(checkSchemaTablesLazy(dir), /Startup chunk assets\/main\.js contains ifc-lite-eager-table:/);
  });

  it('refuses an eager constant reached by a static import from the entry', async () => {
    const dir = dist({ 'main.js': 'import { s } from "./shared.js";', 'ui.js': 'export const x=1;', 'shared.js': `export const s=1;${KEPT}`, 'ids.js': KEPT });
    await assert.rejects(checkSchemaTablesLazy(dir), /Startup chunk assets\/shared\.js contains/);
  });

  it('passes when no chunk keeps any constant (every reader uses a getter)', async () => {
    const dir = dist({ 'main.js': `import "./ui.js";${GETTER_ONLY}`, 'ui.js': 'export const x=1;', 'other.js': GETTER_ONLY });
    const { lazyCount } = await checkSchemaTablesLazy(dir);
    assert.equal(lazyCount, 1);
  });

  it('refuses a build that carries no schema tables at all (the check would prove nothing)', async () => {
    const dir = dist({ 'main.js': 'export const a=1;', 'ui.js': 'export const x=1;', 'other.js': 'export const b=2;' });
    await assert.rejects(checkSchemaTablesLazy(dir), /proves nothing/);
  });
});
