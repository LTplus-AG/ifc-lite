/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// `root-derivation-guard-4204.test.ts` proves `assertRootDerivationIsLive()`
// throws when called directly against a broken registry. It does NOT prove
// the guard is actually wired into the parse path: removing the
// `assertRootDerivationIsLive();` call site from `prepareColumnarEntities`
// (columnar-entity-preparation.ts) leaves that test green, because the test
// never goes through `prepareColumnarEntities`/`parseLite` at all.
//
// This file drives the guard through the real seam — `ColumnarParser.parseLite`
// — with `getInheritanceChain` stubbed so the registry never reaches IFCROOT,
// and asserts the *parse* throws. If the call site is removed, this test
// goes red while the direct-call test stays green, closing that gap.
//
// `assertRootDerivationIsLive()` is memoized via the module-level
// `rootDerivationVerified` latch: once it succeeds once in a given module
// instance, every later call is a no-op. Vitest gives each test FILE its own
// isolated module graph by default, so this file's `columnar-entity-preparation.js`
// instance starts with the latch false regardless of what other test files
// already did. But `vi.mock` + a static top-level `import` are hoisted and
// evaluated once for the whole file, and if some *other* test in this same
// file parsed successfully first, that first successful parse would trip the
// latch and make every subsequent parse in this file skip the check
// vacuously — the exact bug this test exists to catch. To make that
// impossible by construction (not just "we didn't happen to add such a
// test"), this file resets the module registry with `vi.resetModules()`
// immediately before importing and using the parser, and contains ONLY the
// one broken-registry test — no earlier successful parse can taint it.
vi.mock('../src/ifc-schema.js', () => ({
  getInheritanceChain: () => ['IfcWall', 'IfcBuildingElement'],
}));

beforeEach(() => {
  vi.resetModules();
});

describe('#4204 — assertRootDerivationIsLive is actually invoked by the parse path', () => {
  it('parseLite throws when the schema registry cannot derive IfcRoot, proving the guard call site is live', async () => {
    // Fresh, post-reset module instances so `rootDerivationVerified` is
    // guaranteed false for this call.
    const { StepTokenizer } = await import('../src/tokenizer.js');
    const { ColumnarParser } = await import('../src/columnar-parser.js');

    const IFC = `#1=IFCOWNERHISTORY($,$,$,$,$,$,$,0);
#10=IFCWALL('0WallGuid00000000001',#1,'Wall',$,$,$,$,$,$);`;
    const source = new TextEncoder().encode(IFC);
    const tokenizer = new StepTokenizer(source);
    const entityRefs = Array.from(tokenizer.scanEntitiesFast()).map((ref) => ({
      expressId: ref.expressId,
      type: ref.type,
      byteOffset: ref.offset,
      byteLength: ref.length,
      lineNumber: ref.line,
    }));
    const parser = new ColumnarParser();

    await expect(
      parser.parseLite(source.buffer.slice(0), entityRefs, {})
    ).rejects.toThrow(/did not reach IFCROOT/);
  });
});
