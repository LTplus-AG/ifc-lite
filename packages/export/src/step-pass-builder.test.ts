/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one rule `step-pass-builder.ts` has, made a test rather than a comment.
 *
 * `buildExportPass` returns a `pass` whose `allowedEntityIds` and
 * `hiddenProductIds` are still `null`. `collectModifications` assigns them
 * afterwards, on that same object, and the pass's predicates read them off
 * `pass` at call time. Anything that breaks that identity — a spread at the
 * return, a caller storing a copy, a well-meaning snapshot of
 * `allowedEntityIds` into a local — leaves every predicate answering from a
 * value that never fills in.
 *
 * That is #2637, and it fails silently: a `visibleOnly` export ships a
 * structurally wrong file rather than throwing. Before the split the rule was
 * enforced by the literal being physically inside `export()`, where there was
 * nothing to copy. Now that it is a function with a return value, the rule
 * needs its own guard.
 */

import { describe, it, expect } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { buildExportPass } from './step-pass-builder.js';

const IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0proj00000000000000000',$,'P',$,$,$,$,$,$);
#10=IFCWALL('0wall10000000000000000',$,'W',$,$,$,$,$,$);
#11=IFCWALL('0wall20000000000000000',$,'W2',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;`;

async function pass() {
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(IFC).buffer, { disableWorkerScan: true });
  return buildExportPass({
    dataStore: store,
    mutationView: null,
    isGeometryEntity: () => false,
    options: { schema: 'IFC4' },
    schema: 'IFC4',
    sourceSchema: 'IFC4',
    converting: false,
    applyMutations: false,
    excludeGeometry: false,
    sourceHeader: undefined,
    schemaToken: 'IFC4',
  });
}

describe('buildExportPass returns the object the later phases mutate', () => {
  it('leaves the visibility sets unassigned, as the collection phase expects', async () => {
    // If these arrived pre-populated, `collectModifications` would be writing
    // over a decision something else already made.
    const p = await pass();
    expect(p.allowedEntityIds).toBeNull();
    expect(p.hiddenProductIds).toBeNull();
  });

  it('lets willBeEmitted see an allowedEntityIds assigned AFTER the build', async () => {
    const p = await pass();

    // Null means "no visibility restriction decided yet", so nothing is denied
    // on that basis.
    expect(p.willBeEmitted(10)).toBe(true);
    expect(p.willBeEmitted(11)).toBe(true);

    // What `collectModifications` does, in one line: assign onto the returned
    // object. A predicate reading a snapshot taken at build time would still
    // see `null` here and answer `true` for #11.
    p.allowedEntityIds = new Set<number>([10]);

    expect(p.willBeEmitted(10)).toBe(true);
    expect(p.willBeEmitted(11)).toBe(false);
  });

  it('lets the closure-walk predicate see hiddenProductIds assigned after the build', async () => {
    const p = await pass();
    expect(p.isRefExcludedDuringClosureWalk(11)).toBe(false);

    p.hiddenProductIds = new Set<number>([11]);

    // Same object, so the same closure now answers differently.
    expect(p.isRefExcludedDuringClosureWalk(11)).toBe(true);
  });
});
