/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `classification=` against a genuinely ABSENT `IfcClassificationReference`
 * attribute (`$`) vs a genuinely EMPTY one (`''`) — issue #4930.
 *
 * `matchStringAnyNone`'s shared `lower()` used to coerce both to `''` before
 * either reached the comparison, so `classification=""` matched a ref with
 * no Identification/Name at all, and `classification!=""` failed to match
 * it. `matchClassificationRule` (`filter-match.ts`) used to make this worse
 * for the absent case specifically: it dropped a ref's Identification/Name
 * from the candidate list on a truthy check, so a ref whose BOTH attributes
 * are `$` contributed nothing at all, collapsing "classified but unnamed"
 * into `matchStringAnyNone`'s zero-candidate case ("not classified"), which
 * never matches — including the negative ops.
 *
 * Fixture: two walls, each associated with its own `IfcClassificationReference`
 * under the same `IfcClassification` system —
 *   #110 Wall-Absent -> #101 IfcClassificationReference($,$,$,#100,$,$)   Identification/Name both `$`
 *   #111 Wall-Empty  -> #102 IfcClassificationReference($,'ID-002','',#100,$,$)  Identification set, Name explicitly `''`
 *
 * `extractClassificationsOnDemand` already preserves `$` as `undefined`
 * distinctly from `''` at the parse layer (unlike `EntityTable.getName`,
 * which collapses both to `''` well before the search layer — see the
 * #4930 PR body for why `name=`/`parent=`/`type=` aren't fixed here), so
 * this dimension can actually exercise the fix end-to-end through a real
 * parse.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { evaluateFilterRules } from './filter-evaluate.js';
import { Rule } from './filter-rules.js';

const CLASSIFICATION_IFC = `ISO-10303-21;
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
#100= IFCCLASSIFICATION('SourceX',$,$,'MySystem',$,$);
#101= IFCCLASSIFICATIONREFERENCE($,$,$,#100,$,$);
#102= IFCCLASSIFICATIONREFERENCE($,'ID-002','',#100,$,$);
#110= IFCWALL('0Wall0000000000000010A',$,'Wall-Absent',$,$,#40,$,'tag',$);
#111= IFCWALL('0Wall0000000000000011A',$,'Wall-Empty',$,$,#40,$,'tag',$);
#120= IFCRELASSOCIATESCLASSIFICATION('0RelA000000000000001',$,$,$,(#110),#101);
#121= IFCRELASSOCIATESCLASSIFICATION('0RelA000000000000002',$,$,$,(#111),#102);
ENDSEC;
END-ISO-10303-21;
`;

const WALL_ABSENT = 110; // classification ref's Identification AND Name are $
const WALL_EMPTY = 111;  // classification ref's Identification is set, Name is ''

async function parseClassificationStore(): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(CLASSIFICATION_IFC);
  return new IfcParser().parseColumnar(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
}

describe('evaluateFilterRules — classification= absent vs empty (#4930)', () => {
  it('classification="" matches the genuinely-empty Name, not the absent one', async () => {
    const store = await parseClassificationStore();
    const out = evaluateFilterRules('m1', store, [Rule.classification('', 'eq', '')], 'AND');
    const ids = out.map((e) => e.expressId);
    assert.ok(ids.includes(WALL_EMPTY), `Wall-Empty's Name is really '' and must match ""=, got ${ids}`);
    assert.ok(!ids.includes(WALL_ABSENT), `Wall-Absent has no Name at all and must NOT match ""=, got ${ids}`);
  });

  it('classification!="" matches the absent ref (nothing to be equal to ""), and misses the empty one', async () => {
    const store = await parseClassificationStore();
    const out = evaluateFilterRules('m1', store, [Rule.classification('', 'ne', '')], 'AND');
    const ids = out.map((e) => e.expressId);
    assert.ok(
      ids.includes(WALL_ABSENT),
      `Wall-Absent's classification has no Identification/Name — "not equal to empty" is vacuously true, got ${ids}`,
    );
    assert.ok(
      !ids.includes(WALL_EMPTY),
      `Wall-Empty's Name IS '' — it must NOT satisfy != "", got ${ids}`,
    );
  });

  it('classification contains "" only matches a ref that HAS a real string attribute', async () => {
    const store = await parseClassificationStore();
    const out = evaluateFilterRules('m1', store, [Rule.classification('', 'contains', '')], 'AND');
    const ids = out.map((e) => e.expressId);
    assert.ok(
      ids.includes(WALL_EMPTY),
      `Wall-Empty has real strings ('ID-002', '') — every string contains "", got ${ids}`,
    );
    assert.ok(
      !ids.includes(WALL_ABSENT),
      `Wall-Absent has no string to contain anything, including "", got ${ids}`,
    );
  });
});
