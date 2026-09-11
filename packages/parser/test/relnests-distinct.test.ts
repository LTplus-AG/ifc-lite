/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { StepTokenizer } from '../src/tokenizer.js';
import { ColumnarParser } from '../src/columnar-parser.js';
import { RelationshipType } from '@ifc-lite/data';

// IfcRelNests was folded onto the same RelationshipType.Aggregates edge
// bucket as IfcRelAggregates (#4205): a caller asking "what is aggregated
// under this object" could not tell a real IfcRelAggregates decomposition
// apart from an IfcRelNests one, because both landed as the exact same edge
// type with no way to recover which STEP keyword produced it.
//
// #20 (a building) both AGGREGATES #10 (a wall — real physical decomposition)
// and NESTS #21 (a storey — used here as a stand-in for any non-aggregation
// grouping; #4330's WorkPlan -> WorkSchedule grouping is the live example
// elsewhere in the codebase).
const IFC = `#1=IFCOWNERHISTORY($,$,$,$,$,$,$,0);
#10=IFCWALL('wall-1',#1,'Wall A',$,$,$,$,$);
#20=IFCBUILDING('bldg-1',#1,'Bldg',$,$,$,$,$,$,$,$);
#21=IFCBUILDINGSTOREY('storey-1',#1,'Storey',$,$,$,$,$,$,$);
#50=IFCRELNESTS('rel-nests',#1,$,$,#20,(#21));
#51=IFCRELAGGREGATES('rel-agg',#1,$,$,#20,(#10));
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

describe('IfcRelNests distinct from IfcRelAggregates (#4205)', () => {
  it('the Nests edge type contains ONLY the nested target, not the aggregated one', async () => {
    const store = await parse();
    const nested = store.relationships!.getRelated(20, RelationshipType.Nests, 'forward');
    expect(nested).toEqual([21]);
  });

  it('both directions: existing Aggregates-based traversal still sees the nesting target too (unchanged)', async () => {
    // Consumers that pre-date this fix (spatial-hierarchy-builder.ts,
    // decomposition.ts, owning-project.ts, the IDS partOf/ancestors bridge)
    // rely on IfcRelNests continuing to show up under RelationshipType.Aggregates
    // — verified here as a before/after-preserving control, not a new feature.
    const store = await parse();
    const aggregated = store.relationships!.getRelated(20, RelationshipType.Aggregates, 'forward').sort((a, b) => a - b);
    expect(aggregated).toEqual([10, 21]);
  });

  it('a real IfcRelAggregates edge does NOT also appear under Nests', async () => {
    const store = await parse();
    const nested = store.relationships!.getRelated(20, RelationshipType.Nests, 'forward');
    expect(nested).not.toContain(10);
  });

  it('the Nests edge resolves back to the actual IfcRelNests relationship id', async () => {
    const store = await parse();
    const edges = store.relationships!.forward.getEdges(20, RelationshipType.Nests);
    expect(edges).toHaveLength(1);
    expect(edges[0].relationshipId).toBe(50);
    expect(edges[0].target).toBe(21);
  });
});
