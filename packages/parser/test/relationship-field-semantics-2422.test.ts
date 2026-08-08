/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { StepTokenizer } from '../src/tokenizer.js';
import { ColumnarParser, extractRelationshipsOnDemand } from '../src/columnar-parser.js';

// Issue #2422 asked whether `EntityRelationshipsData`'s field names violate the
// "user-facing APIs use exact IFC EXPRESS names" rule and should be renamed to
// `IfcRelVoidsElement` / `IfcRelFillsElement` / ... (or, failing that, `voids`
// to `openings`). The answer turns entirely on WHAT THE ARRAYS HOLD, which no
// test pinned. They hold the related OBJECTS, never the `IfcRel*` entities:
//
//   voids  = the IfcOpeningElements that void a host   (host   -> opening)
//   fills  = the IfcOpeningElement a filler sits in    (filler -> opening)
//
// so `IfcRelVoidsElement` would name a field after a type none of its members
// has, and `openings` would apply equally to `fills` — only the voids/fills
// pair, buildingSMART's own vocabulary for the two directions, tells them
// apart. That is the evidence behind resolving #2422 as won't-fix, and it is
// only evidence for as long as it stays true, hence this test.
//
// Neutral synthetic fixture: one wall, one opening in it, one door filling
// that opening, plus the two IfcRel* entities wiring them together.
const IFC = `#1=IFCOWNERHISTORY($,$,$,$,$,$,$,0);
#10=IFCWALL('wall-1',#1,'Exterior Wall',$,$,$,$,$);
#20=IFCOPENINGELEMENT('opening-1',#1,'Door Opening',$,$,$,$,$,$);
#30=IFCDOOR('door-1',#1,'Entrance Door',$,$,$,$,$,$,$,$,$,$);
#40=IFCRELVOIDSELEMENT('rel-voids-1',#1,$,$,#10,#20);
#41=IFCRELFILLSELEMENT('rel-fills-1',#1,$,$,#20,#30);`;

async function parse() {
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
  return parser.parseLite(source.buffer.slice(0), entityRefs, {});
}

describe('#2422 — what the relationship arrays actually hold', () => {
  it("puts the host's IfcOpeningElement in `voids`, not the IfcRelVoidsElement", async () => {
    const store = await parse();
    const rels = extractRelationshipsOnDemand(store, 10);

    expect(rels.voids).toEqual([{ id: 20, name: 'Door Opening', type: 'IfcOpeningElement' }]);
    // A wall is not itself the filler of anything.
    expect(rels.fills).toEqual([]);
  });

  it("puts the filler's IfcOpeningElement in `fills`, not the IfcRelFillsElement", async () => {
    const store = await parse();
    const rels = extractRelationshipsOnDemand(store, 30);

    expect(rels.fills).toEqual([{ id: 20, name: 'Door Opening', type: 'IfcOpeningElement' }]);
    // A door has no openings of its own in this model.
    expect(rels.voids).toEqual([]);
  });

  it('gives `voids` and `fills` members of the SAME type, so `openings` cannot name just one', async () => {
    const store = await parse();
    const hostSide = extractRelationshipsOnDemand(store, 10).voids;
    const fillerSide = extractRelationshipsOnDemand(store, 30).fills;

    expect(hostSide.map((v) => v.type)).toEqual(['IfcOpeningElement']);
    expect(fillerSide.map((f) => f.type)).toEqual(['IfcOpeningElement']);
    // Same entity reached from both directions — the field name is the only
    // thing distinguishing "the opening I have" from "the opening I fill".
    expect(hostSide[0]?.id).toBe(fillerSide[0]?.id);
  });

  it('never surfaces an IfcRel* entity in any of the four arrays', async () => {
    const store = await parse();
    const relIds = [40, 41];

    for (const entityId of [10, 20, 30]) {
      const rels = extractRelationshipsOnDemand(store, entityId);
      const members = [...rels.voids, ...rels.fills, ...rels.groups, ...rels.connections];
      for (const member of members) {
        expect(relIds).not.toContain(member.id);
        expect(member.type.startsWith('IfcRel')).toBe(false);
      }
    }
  });
});
