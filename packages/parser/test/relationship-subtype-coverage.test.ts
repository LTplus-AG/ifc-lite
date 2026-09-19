/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { StepTokenizer } from '../src/tokenizer.js';
import { ColumnarParser } from '../src/columnar-parser.js';
import { RelationshipType } from '@ifc-lite/data';

// Before #4205, IfcRelAssignsToActor, IfcRelDeclares and IfcRelSequence were
// not in HIERARCHY_REL_TYPES at all: they never reached `extractRelFast`, so
// every one of these relationships parsed to nothing — not merged into a
// broader bucket (there was no bucket), just silently absent from the graph.
//
// #10/#11/#12 stand in for arbitrary related objects — the byte-level
// scanner reads whichever `#id` sits at the schema-derived position
// regardless of the referenced entity's own EXPRESS type, so a plain
// IfcWall is enough to prove the relationship-level extraction; nothing
// here exercises attribute typing.
//
// #20 (IfcRelAssignsToActor) deliberately assigns TWO related objects
// (#10, #11) from a SINGLE relationship record, guarding against counting
// edge targets instead of distinct relationship records (the mistake #4496
// found and fixed in `parquet-exporter.ts`'s `relationshipCount`): 2 edges,
// 1 record.
const IFC = `#1=IFCOWNERHISTORY($,$,$,$,$,$,$,0);
#10=IFCWALL('w1',#1,'Wall1',$,$,$,$,$);
#11=IFCWALL('w2',#1,'Wall2',$,$,$,$,$);
#12=IFCWALL('w3',#1,'Wall3',$,$,$,$,$);
#20=IFCRELASSIGNSTOACTOR('ra',#1,$,$,(#10,#11),$,#12);
#21=IFCRELDECLARES('rd',#1,$,$,#12,(#10));
#22=IFCRELSEQUENCE('rs',#1,$,$,#10,#11);
`;

const STRUCTURAL_IFC = `#1=IFCOWNERHISTORY($,$,$,$,$,$,$,0);
#10=IFCWALL('w1',#1,'Wall1',$,$,$,$,$);
#11=IFCWALL('w2',#1,'Wall2',$,$,$,$,$);
#12=IFCWALL('w3',#1,'Wall3',$,$,$,$,$);
#13=IFCWALL('w4',#1,'Wall4',$,$,$,$,$);
#30=IFCRELCONNECTSSTRUCTURALACTIVITY('sa',#1,$,$,#10,#11);
#31=IFCRELCONNECTSSTRUCTURALMEMBER('sm',#1,$,$,#11,#12,$,$,$,$);
#32=IFCRELCONNECTSWITHECCENTRICITY('se',#1,$,$,#12,#13,$,$,$,$,$);
#33=IFCRELCONNECTSSTRUCTURALELEMENT('sx',#1,$,$,#13,#10);
`;

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

async function parseStructural() {
  const source = new TextEncoder().encode(STRUCTURAL_IFC);
  const tokenizer = new StepTokenizer(source);
  const entityRefs = Array.from(tokenizer.scanEntitiesFast()).map((ref) => ({
    expressId: ref.expressId,
    type: ref.type,
    byteOffset: ref.offset,
    byteLength: ref.length,
    lineNumber: ref.line,
  }));
  return new ColumnarParser().parseLite(source.buffer.slice(0), entityRefs, {});
}

describe('previously wholly-unindexed IfcRelationship subtypes (#4205)', () => {
  it('IfcRelAssignsToActor: RelatingActor is the LAST attribute, RelatedObjects the FIRST (inherited order)', async () => {
    const store = await parse();
    const assigned = store.relationships!.getRelated(12, RelationshipType.AssignsToActor, 'forward').sort((a, b) => a - b);
    expect(assigned).toEqual([10, 11]);
  });

  it('IfcRelDeclares gets its own edge type, distinct from AssignsToActor even though it also touches #12', async () => {
    const store = await parse();
    const declared = store.relationships!.getRelated(12, RelationshipType.Declares, 'forward');
    expect(declared).toEqual([10]);
    // Not folded into AssignsToActor or any other bucket. Checked by
    // relationship RECORD id (#21), not by target entity id: getRelated()
    // returns edge.target (10/11 here), so a target-id check can never see
    // a relationship record misclassified as AssignsToActor — only
    // inspecting relationshipId/shadowedRelationshipIds on the actual edges
    // can (CodeRabbit finding on #4672, verified against
    // relationship-graph.ts's Edge shape).
    const assignsEdges = store.relationships!.forward.getEdges(12, RelationshipType.AssignsToActor);
    const assignsRelationshipIds = assignsEdges.flatMap((edge) => [
      edge.relationshipId,
      ...(edge.shadowedRelationshipIds ?? []),
    ]);
    expect(assignsRelationshipIds).not.toContain(21);
  });

  it('IfcRelSequence: both RelatingProcess and RelatedProcess are single references', async () => {
    const store = await parse();
    expect(store.relationships!.getRelated(10, RelationshipType.Sequence, 'forward')).toEqual([11]);
  });

  it('vacuity guard: two related objects from ONE relationship record count as ONE distinct record, not two', async () => {
    const store = await parse();
    const edges = store.relationships!.forward.getEdges(12, RelationshipType.AssignsToActor);
    expect(edges).toHaveLength(2); // two edge targets (#10, #11)
    const distinctRelationshipIds = new Set(edges.map(e => e.relationshipId));
    expect(distinctRelationshipIds.size).toBe(1); // both came from the same #20 record
    expect(distinctRelationshipIds.has(20)).toBe(true);
  });

  it('each new edge resolves back to its own IfcRel* record id, not a shared/aliased one', async () => {
    const store = await parse();
    const declareEdges = store.relationships!.forward.getEdges(12, RelationshipType.Declares);
    expect(declareEdges).toHaveLength(1);
    expect(declareEdges[0].relationshipId).toBe(21);
    const sequenceEdges = store.relationships!.forward.getEdges(10, RelationshipType.Sequence);
    expect(sequenceEdges).toHaveLength(1);
    expect(sequenceEdges[0].relationshipId).toBe(22);
  });

  it('records every structural connection as a distinct forward and inverse edge with its own relationship id', async () => {
    const store = await parseStructural();
    const cases = [
      [10, 11, RelationshipType.ConnectsStructuralActivity, 30],
      [11, 12, RelationshipType.ConnectsStructuralMember, 31],
      [12, 13, RelationshipType.ConnectsWithEccentricity, 32],
      [13, 10, RelationshipType.ConnectsStructuralElement, 33],
    ] as const;
    for (const [relating, related, type, relationshipId] of cases) {
      expect(store.relationships!.forward.getEdges(relating, type)).toEqual([
        { target: related, type, relationshipId },
      ]);
      expect(store.relationships!.inverse.getEdges(related, type)).toEqual([
        { target: relating, type, relationshipId },
      ]);
    }
    // Eccentricity is a subclass of structural-member connection but is not
    // an alias: its graph edge retains its own enum bucket and STEP record.
    expect(store.relationships!.forward.getEdges(12, RelationshipType.ConnectsStructuralMember)).toEqual([]);
    expect(store.relationships!.forward.getEdges(12, RelationshipType.ConnectsWithEccentricity)[0].relationshipId).toBe(32);
  });
});
