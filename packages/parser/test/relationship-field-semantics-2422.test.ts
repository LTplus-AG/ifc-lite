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
// Neutral synthetic fixture. It populates ALL FOUR arrays, not just the two
// the voids/fills argument turns on, so the "no IfcRel* anywhere" assertion
// below exercises every field it claims to cover:
//   voids       #10 -> #20   via IfcRelVoidsElement        (#40)
//   fills       #30 -> #20   via IfcRelFillsElement        (#41)
//   groups      #10 -> #50   via IfcRelAssignsToGroup      (#42)
//   connections #10 <-> #11  via IfcRelConnectsPathElements (#43)
const IFC = `#1=IFCOWNERHISTORY($,$,$,$,$,$,$,0);
#10=IFCWALL('wall-1',#1,'Exterior Wall',$,$,$,$,$);
#11=IFCWALL('wall-2',#1,'Party Wall',$,$,$,$,$);
#20=IFCOPENINGELEMENT('opening-1',#1,'Door Opening',$,$,$,$,$,$);
#30=IFCDOOR('door-1',#1,'Entrance Door',$,$,$,$,$,$,$,$,$,$);
#50=IFCZONE('zone-1',#1,'Fire Compartment A',$,$,$);
#40=IFCRELVOIDSELEMENT('rel-voids-1',#1,$,$,#10,#20);
#41=IFCRELFILLSELEMENT('rel-fills-1',#1,$,$,#20,#30);
#42=IFCRELASSIGNSTOGROUP('rel-group-1',#1,$,$,(#10),$,#50);
#43=IFCRELCONNECTSPATHELEMENTS('rel-conn-1',#1,$,$,$,#10,#11,$,$,.ATSTART.,.ATEND.);`;

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
    const relIds = [40, 41, 42, 43];
    // Every IfcRel* in the fixture must be reachable from the entities swept,
    // or "no IfcRel* leaked" would just mean "nothing was looked at".
    const populated = { voids: 0, fills: 0, groups: 0, connections: 0 };

    for (const entityId of [10, 11, 20, 30, 50]) {
      const rels = extractRelationshipsOnDemand(store, entityId);
      // `groups` members declare no `type`, so widen to the common shape
      // rather than branching per field.
      const byField: Record<keyof typeof populated, Array<{ id: number; type?: string }>> = {
        voids: rels.voids,
        fills: rels.fills,
        groups: rels.groups,
        connections: rels.connections,
      };
      for (const [field, members] of Object.entries(byField)) {
        populated[field as keyof typeof populated] += members.length;
        for (const member of members) {
          expect(relIds).not.toContain(member.id);
          expect(member.type?.startsWith('IfcRel') ?? false).toBe(false);
        }
      }
    }

    // The guard above is vacuous for any array that stayed empty. All four
    // carried members, so all four were actually checked.
    expect(populated).toEqual({ voids: 1, fills: 1, groups: 1, connections: 2 });
  });
});
