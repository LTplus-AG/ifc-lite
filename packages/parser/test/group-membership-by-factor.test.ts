/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { StepTokenizer } from '../src/tokenizer.js';
import {
  ColumnarParser,
  extractRelationshipsOnDemand,
  extractGroupMembersOnDemand,
  extractGroupAssignmentFactorOnDemand,
} from '../src/columnar-parser.js';
import { RelationshipType } from '@ifc-lite/data';

// IfcRelAssignsToGroupByFactor (IFC2X3/IFC4/IFC4X3) is a SUBTYPE of
// IfcRelAssignsToGroup — same RelatingGroup/RelatedObjects membership
// semantics, plus a proportional Factor attribute — but it is written to
// STEP under its own distinct entity keyword. `HIERARCHY_REL_TYPES` /
// `RELATIONSHIP_TYPES` / `REL_TYPE_MAP` (columnar-parser-indexes.ts) and the
// `extractRelFast` byte scanner (columnar-parser-relationships.ts) matched
// only the literal 'IFCRELASSIGNSTOGROUP' string, so a ByFactor relationship
// never reached the categorized `relationshipRefs` bucket: it fell through
// to CAT_RELEVANT (its keyword starts with 'IFCREL') and was parsed only for
// GlobalId/Name, never turned into a graph edge. Any element assigned to a
// zone/system exclusively through IfcRelAssignsToGroupByFactor was silently
// invisible to both "members of this group" and "groups of this element".
const IFC = `#1=IFCOWNERHISTORY($,$,$,$,$,$,$,0);
#10=IFCWALL('wall-1',#1,'Wall A',$,$,$,$,$);
#11=IFCWALL('wall-2',#1,'Wall B',$,$,$,$,$);
#12=IFCWALL('wall-3',#1,'Wall C',$,$,$,$,$);
#13=IFCWALL('wall-4',#1,'Wall D',$,$,$,$,$);
#30=IFCSYSTEM('sys-1',#1,'HVAC System',$,'HVAC');
#31=IFCZONE('zone-1',#1,'Thermal Zone',$,$,$);
#32=IFCZONE('zone-2',#1,'Zero Factor Zone',$,$,$);
// wall-1 -> sys-1 via the plain (non-factor) relationship: control.
#40=IFCRELASSIGNSTOGROUP('rel-plain',#1,$,$,(#10),$,#30);
// wall-2 -> sys-1 EXCLUSIVELY via IfcRelAssignsToGroupByFactor.
#41=IFCRELASSIGNSTOGROUPBYFACTOR('rel-factor',#1,$,$,(#11),$,#30,0.5);
// wall-3 -> zone-1 via factor AND independently assigned into sys-1 via the
// plain relationship (multiple membership across both relationship kinds).
#42=IFCRELASSIGNSTOGROUPBYFACTOR('rel-factor-2',#1,$,$,(#12),$,#31,0.75);
#43=IFCRELASSIGNSTOGROUP('rel-plain-2',#1,$,$,(#12),$,#30);
// wall-4 -> zone-2 with a LEGITIMATE zero Factor: 0 is a valid proportional
// share, not "no Factor attribute" — must read back as 0, not undefined.
// A fresh entity (not wall-1/2/3) so this fixture doesn't perturb the
// group-membership assertions above, which pin exact member/group lists.
#44=IFCRELASSIGNSTOGROUPBYFACTOR('rel-factor-zero',#1,$,$,(#13),$,#32,0.0);`;

async function parse() {
  const source = new TextEncoder().encode(IFC.split('\n').filter(l => !l.trim().startsWith('//')).join('\n'));
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

describe('IfcRelAssignsToGroupByFactor membership', () => {
  it('resolves group -> members through the ByFactor relationship, not just the plain one', async () => {
    const store = await parse();
    const sysMembers = extractGroupMembersOnDemand(store, 30).map(m => m.id).sort((a, b) => a - b);
    // wall-1 (plain) + wall-3 (plain) are the control; wall-2 is assigned
    // EXCLUSIVELY via IfcRelAssignsToGroupByFactor — the regression is that
    // it used to be dropped entirely from this list.
    expect(sysMembers).toEqual([10, 11, 12]);

    const zoneMembers = extractGroupMembersOnDemand(store, 31).map(m => m.id);
    expect(zoneMembers).toEqual([12]);
  });

  it('resolves element -> groups for an element assigned only via ByFactor', async () => {
    const store = await parse();
    const wall2Groups = extractRelationshipsOnDemand(store, 11).groups.map(g => g.id);
    expect(wall2Groups).toEqual([30]);
  });

  it('keeps multiple membership: an element in two distinct groups via two different relationship kinds', async () => {
    const store = await parse();
    const wall3Groups = extractRelationshipsOnDemand(store, 12).groups.map(g => g.id).sort();
    expect(wall3Groups).toEqual([30, 31]);
  });

  it('bidirectional consistency: every group->member edge has a matching member->group edge', async () => {
    const store = await parse();
    for (const groupId of [30, 31]) {
      for (const member of extractGroupMembersOnDemand(store, groupId)) {
        const memberGroups = extractRelationshipsOnDemand(store, member.id).groups.map(g => g.id);
        expect(memberGroups).toContain(groupId);
      }
    }
  });

  it('control: a plain-only group membership is unaffected', async () => {
    const store = await parse();
    const wall1Groups = extractRelationshipsOnDemand(store, 10).groups.map(g => g.id);
    expect(wall1Groups).toEqual([30]);
  });

  // Prior to #4205's fix, IfcRelAssignsToGroupByFactor was folded onto the
  // exact same RelationshipType.AssignsToGroup edge as a plain
  // IfcRelAssignsToGroup — indistinguishable from it, and with no way for a
  // caller to recover the relationship id needed to read `Factor` back off
  // the underlying entity.
  it('distinguishes a ByFactor assignment from a plain one via a distinct edge type', async () => {
    const store = await parse();
    const byFactor = store.relationships!.getRelated(30, RelationshipType.AssignsToGroupByFactor, 'forward');
    expect(byFactor).toEqual([11]);
    // wall-1's plain assignment does NOT also appear under the ByFactor type.
    expect(byFactor).not.toContain(10);
  });

  it('both directions: existing AssignsToGroup-based membership traversal is unchanged (control)', async () => {
    const store = await parse();
    // extractGroupMembersOnDemand / extractRelationshipsOnDemand (used
    // throughout this file) read RelationshipType.AssignsToGroup — confirm
    // wall-2 (ByFactor-only) still resolves through it exactly as before.
    const sysMembers = extractGroupMembersOnDemand(store, 30).map(m => m.id).sort((a, b) => a - b);
    expect(sysMembers).toEqual([10, 11, 12]);
  });

  it('preserves the Factor value on a ByFactor assignment, resolvable by (group, member)', async () => {
    const store = await parse();
    expect(extractGroupAssignmentFactorOnDemand(store, 30, 11)).toBe(0.5);
    expect(extractGroupAssignmentFactorOnDemand(store, 31, 12)).toBe(0.75);
  });

  it('returns undefined for a plain (non-ByFactor) assignment — absent, not zero', async () => {
    const store = await parse();
    // wall-1 -> sys-1 is assigned only via plain IfcRelAssignsToGroup, which
    // carries no Factor attribute at all. Must be undefined, not 0 or NaN —
    // conflating "no Factor attribute exists" with "Factor is 0" would be
    // the same absent-vs-empty defect class the issue warns about.
    expect(extractGroupAssignmentFactorOnDemand(store, 30, 10)).toBeUndefined();
  });

  it('returns undefined for a (group, member) pair with no assignment at all', async () => {
    const store = await parse();
    expect(extractGroupAssignmentFactorOnDemand(store, 31, 10)).toBeUndefined();
  });

  // `extractGroupAssignmentFactorOnDemand` guards with
  // `typeof factorAttr.value === 'number'`, not a truthiness check — correct,
  // since a truthy check (`if (factor)`) would swallow a legitimate `0` and
  // silently report it as "no Factor attribute" (undefined). This pins that
  // behaviour so a future edit can't reintroduce the truthy-check bug.
  it('returns 0, not undefined, for a legitimate zero Factor', async () => {
    const store = await parse();
    expect(extractGroupAssignmentFactorOnDemand(store, 32, 13)).toBe(0);
  });
});
