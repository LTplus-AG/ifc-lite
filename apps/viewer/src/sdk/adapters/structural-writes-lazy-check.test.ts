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
import { checkStructuralWritesLazy } from '../../../scripts/check-structural-writes-lazy.mjs';

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

/**
 * One line per structural write function, written by hand from the minified
 * impl chunk of a real viewer build, NOT derived from the gate's signature
 * list: if a signature were dropped from the gate, this fixture keeps the
 * builder, and the "each builder missing" case below fails (#9753 review).
 */
const BUILDER_CODE: Record<string, string> = {
  addStructuralAnalysisModelToStore: 'throw Error(`addStructuralAnalysisModelToStore: ObjectType is required when PredefinedType is USERDEFINED`)',
  addStructuralCurveMemberToStore: 'throw Error(`addStructuralCurveMemberToStore: Start and End must be distinct points`)',
  addStructuralPointConnectionToStore: 'throw Error(`addStructuralPointConnectionToStore: ${k} must be a finite spring stiffness`)',
  addStructuralLoadGroupToStore: 'throw Error(`addStructuralLoadGroupToStore: IFC2X3 IfcStructuralLoadGroup has no SelfWeightCoefficients`)',
  addStructuralPointActionToStore: 'L(`addStructuralPointActionToStore`,[r.ForceX,r.ForceY])',
  addStructuralLinearActionToStore: 'L(`addStructuralLinearActionToStore`,[r.LinearForceX])',
  connectStructuralMemberToConnectionInStore: 'return e.addEntity(`IfcRelConnectsStructuralMember`,[c,i,null,null,`#${m}`,`#${n}`])',
  connectStructuralActivityToItemInStore: 'return e.addEntity(`IfcRelConnectsStructuralActivity`,[c,i,null,null,`#${m}`,`#${n}`])',
  assignToStructuralGroupInStore: 'throw Error(`assignToStructuralGroupInStore: objectIds must be non-empty`)',
  createStructuralStoreBackend: 'throw Error(`bim.store structural authoring: schema \'${t}\' is not supported; use IFC4 or IFC4X3.`)',
};
const buildersWithout = (omit?: string) =>
  Object.entries(BUILDER_CODE).filter(([name]) => name !== omit).map(([, code], i) => `function f${i}(){${code}}`).join(';');
const BUILDERS = buildersWithout();

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
    await assert.rejects(checkStructuralWritesLazy(dir), /Startup chunk assets\/shared\.js contains addStructural/);
  });

  it('refuses builder code in a modulepreloaded chunk', async () => {
    const dir = dist({ 'main.js': 'export {}', 'ui.js': 'throw new Error(`bim.store structural authoring: schema`);', 'structural.js': BUILDERS });
    await assert.rejects(checkStructuralWritesLazy(dir), /Startup chunk assets\/ui\.js contains bim\.store structural authoring:/);
  });

  it('refuses a build whose lazy chunk lacks any one structural write function', async () => {
    for (const name of Object.keys(BUILDER_CODE)) {
      const dir = dist({ 'main.js': 'import("./structural.js");', 'ui.js': 'export {}', 'structural.js': buildersWithout(name) });
      // The refusal names what is missing; each named signature must come from the omitted function's own code.
      await assert.rejects(checkStructuralWritesLazy(dir), (error: Error) => {
        const missing = /carries (.+) code, so this check proves nothing/.exec(error.message)?.[1].split(', ') ?? [];
        return missing.length > 0 && missing.every((signature) => BUILDER_CODE[name].includes(signature));
      }, `${name} missing from the lazy chunk must be noticed`);
    }
  });

  it('refuses a build with no structural write code at all, so it cannot pass vacuously', async () => {
    const dir = dist({ 'main.js': 'import("./other.js");', 'ui.js': 'export {}', 'other.js': 'export const y=2;' });
    await assert.rejects(checkStructuralWritesLazy(dir), /proves nothing/);
  });
});
