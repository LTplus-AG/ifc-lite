/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `name=`/`parent=` against a genuinely ABSENT `Name` (`$`) vs a genuinely
 * EMPTY one (`''`) — issue #4930's own confirmed repro: a storey whose
 * `Name` is `$`, with an element contained in it, where `parent=""`
 * incorrectly matched the element and `parent!=""` incorrectly failed to.
 *
 * Unlike `classification=` (`filter-evaluate-classification-absent.test.ts`),
 * this dimension routes through `EntityTable.getName`, which folds absent
 * and explicit-empty into the SAME `''` at parse time — `store.entities`'s
 * `name` column stores `StringTable.NULL_INDEX` (as its unsigned bit
 * pattern) for the absent case and index 0 (the canonical `''`) for the
 * empty one, but `getName` deliberately answers `''` for both, because 61+
 * other call sites read it for DISPLAY, where the two cases render
 * identically. `getNameOrUndefined` (`packages/data/src/entity-table.ts`) is
 * the accessor that keeps them apart, and `nameOrUndefined` (`filter-match.ts`)
 * is what `parent=`/`name=` matching now calls instead of `getName`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { evaluateFilterRules } from './filter-evaluate.js';
import { Rule } from './filter-rules.js';

const ABSENT_NAME_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('0Proj000000000000000001',$,'Proj',$,$,$,$,(#20),#30);
#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21= IFCAXIS2PLACEMENT3D(#22,$,$);
#22= IFCCARTESIANPOINT((0.,0.,0.));
#30= IFCUNITASSIGNMENT((#31));
#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#40= IFCLOCALPLACEMENT($,#21);
#43= IFCBUILDINGSTOREY('0StoreyAbsentName00001',$,$,$,$,#40,$,$,.ELEMENT.,9.);
#44= IFCBUILDINGSTOREY('0StoreyEmptyName000001',$,'',$,$,#40,$,$,.ELEMENT.,9.);
#51= IFCWALL('0WallInAbsentStorey0001',$,'Wall-In-Absent-Storey',$,$,#40,$,'tag',$);
#52= IFCWALL('0WallInEmptyStorey00001',$,'Wall-In-Empty-Storey',$,$,#40,$,'tag',$);
#53= IFCWALL('0WallNameAbsent0000001',$,$,$,$,#40,$,'tag',$);
#54= IFCWALL('0WallNameEmpty0000001A',$,'',$,$,#40,$,'tag',$);
#70= IFCRELCONTAINEDINSPATIALSTRUCTURE('0Cont0000000000000001',$,$,$,(#51),#43);
#71= IFCRELCONTAINEDINSPATIALSTRUCTURE('0Cont0000000000000002',$,$,$,(#52),#44);
ENDSEC;
END-ISO-10303-21;
`;

const WALL_IN_ABSENT_STOREY = 51; // #43's Name is $
const WALL_IN_EMPTY_STOREY = 52;  // #44's Name is ''
const WALL_NAME_ABSENT = 53;      // this wall's own Name is $
const WALL_NAME_EMPTY = 54;       // this wall's own Name is ''

async function parseAbsentNameStore(): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(ABSENT_NAME_IFC);
  return new IfcParser().parseColumnar(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
}

describe('evaluateFilterRules — parent= absent vs empty storey Name (#4930)', () => {
  it('parent="" matches the element in the EMPTY-Name storey, not the absent one', async () => {
    const store = await parseAbsentNameStore();
    const out = evaluateFilterRules('m1', store, [Rule.parent('eq', '')], 'AND');
    const ids = out.map((e) => e.expressId);
    assert.ok(ids.includes(WALL_IN_EMPTY_STOREY), `storey #44's Name is really '' and must match ""=, got ${ids}`);
    assert.ok(!ids.includes(WALL_IN_ABSENT_STOREY), `storey #43 has no Name at all and must NOT match ""=, got ${ids}`);
  });

  it('parent!="" matches the element in the ABSENT-Name storey (vacuously not equal to ""), not the empty one', async () => {
    const store = await parseAbsentNameStore();
    const out = evaluateFilterRules('m1', store, [Rule.parent('ne', '')], 'AND');
    const ids = out.map((e) => e.expressId);
    assert.ok(
      ids.includes(WALL_IN_ABSENT_STOREY),
      `storey #43's Name is absent — "not equal to empty" is vacuously true, got ${ids}`,
    );
    assert.ok(
      !ids.includes(WALL_IN_EMPTY_STOREY),
      `storey #44's Name IS '' — it must NOT satisfy != "", got ${ids}`,
    );
  });
});

describe('evaluateFilterRules — name= absent vs empty element Name (#4930)', () => {
  it('name="" matches the element whose OWN Name is really empty, not the one with no Name', async () => {
    const store = await parseAbsentNameStore();
    const out = evaluateFilterRules('m1', store, [Rule.name('eq', '')], 'AND');
    const ids = out.map((e) => e.expressId);
    assert.ok(ids.includes(WALL_NAME_EMPTY), `#54's Name is really '' and must match ""=, got ${ids}`);
    assert.ok(!ids.includes(WALL_NAME_ABSENT), `#53 has no Name at all and must NOT match ""=, got ${ids}`);
  });

  it('name!="" matches the element with no Name at all, not the one whose Name is ""', async () => {
    const store = await parseAbsentNameStore();
    const out = evaluateFilterRules('m1', store, [Rule.name('ne', '')], 'AND');
    const ids = out.map((e) => e.expressId);
    assert.ok(ids.includes(WALL_NAME_ABSENT), `#53's Name is absent — "not equal to empty" is vacuously true, got ${ids}`);
    assert.ok(!ids.includes(WALL_NAME_EMPTY), `#54's Name IS '' — it must NOT satisfy != "", got ${ids}`);
  });
});
