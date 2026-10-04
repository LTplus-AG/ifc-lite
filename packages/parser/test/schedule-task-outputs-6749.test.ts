/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6749 — tasks bound to the product they build via IfcRelAssignsToProduct
 * (task in RelatedObjects, product in RelatingProduct), the shape every
 * leaf task in buildingSMART's construction-scheduling-task example uses.
 * The extractor used to read only IfcRelAssignsToProcess, so such a
 * schedule reached the viewer with no products at all.
 *
 * Real tokenizer + columnar parser + serializer on real STEP bytes.
 */

import { describe, it, expect } from 'vitest';
import { StepTokenizer } from '../src/tokenizer.js';
import { ColumnarParser } from '../src/columnar-parser.js';
import {
  extractScheduleOnDemand,
  serializeScheduleToStep,
  taskProductExpressIds,
  taskProductGlobalIds,
} from '../src/index.js';

const HEADER = [
  'ISO-10303-21;',
  'HEADER;',
  "FILE_DESCRIPTION(('issue 6749'),'2;1');",
  "FILE_NAME('','',(''),(''),'','','');",
  "FILE_SCHEMA(('IFC4'));",
  'ENDSEC;',
  'DATA;',
];
const FOOTER = ['ENDSEC;', 'END-ISO-10303-21;', ''];

/** Mirrors the bSI sample: a parent task, leaf tasks each outputting one product. */
const BODY = [
  "#1=IFCPROJECT('proj',#10,'P',$,$,$,$,$,$);",
  '#10=IFCOWNERHISTORY($,$,$,.NOCHANGE.,$,$,$,0);',
  "#20=IFCSLAB('slab-1',#10,'Slab #1',$,$,$,$,$,$);",
  "#21=IFCWALL('wall-1',#10,'Wall #1',$,$,$,$,$,$);",
  "#22=IFCWALL('wall-2',#10,'Wall #2',$,$,$,$,$,$);",
  "#23=IFCCOLUMN('col-1',#10,'Column #1',$,$,$,$,$,$);",
  "#30=IFCTASKTIME($,$,$,.WORKTIME.,'P1D','2010-09-20T08:00:00',$,'2010-09-20T08:00:00','2010-09-20T16:00:00',$,$,$,$,$,$,$,$,$,$,$);",
  "#31=IFCTASKTIME($,$,$,.WORKTIME.,'P1D','2010-09-21T08:00:00',$,'2010-09-21T08:00:00','2010-09-21T16:00:00',$,$,$,$,$,$,$,$,$,$,$);",
  "#40=IFCTASK('task-ground',#10,'Ground Level',$,$,$,$,$,$,.F.,$,$,$);",
  "#41=IFCTASK('task-slab',#10,'Slab #1',$,$,$,$,$,$,.F.,$,#30,.CONSTRUCTION.);",
  "#42=IFCTASK('task-wall',#10,'Walls',$,$,$,$,$,$,.F.,$,#31,.CONSTRUCTION.);",
  "#50=IFCRELNESTS('nest',#10,$,$,#40,(#41,#42));",
  "#51=IFCRELASSIGNSTOPRODUCT('out-slab',#10,$,$,(#41),$,#20);",
  // One relation, two tasks producing the same product is legal; here one
  // task outputs two walls through two relations, one of them repeated.
  "#52=IFCRELASSIGNSTOPRODUCT('out-wall-1',#10,$,$,(#42),$,#21);",
  "#53=IFCRELASSIGNSTOPRODUCT('out-wall-2',#10,$,$,(#42),$,#22);",
  "#54=IFCRELASSIGNSTOPRODUCT('out-wall-2-dup',#10,$,$,(#42),$,#22);",
  // An input on the same task stays an input.
  "#55=IFCRELASSIGNSTOPROCESS('in-col',#10,$,$,(#23),$,#42,$);",
  // A cost item pricing a product is NOT a task output.
  "#60=IFCCOSTITEM('cost',#10,'Cost',$,$,$,$,$,$);",
  "#61=IFCRELASSIGNSTOPRODUCT('cost-on-wall',#10,$,$,(#60),$,#21);",
];

async function parseStep(stepText: string) {
  const buffer = new TextEncoder().encode(stepText).buffer.slice(0) as ArrayBuffer;
  const tokenizer = new StepTokenizer(new Uint8Array(buffer));
  const refs = [];
  for (const ref of tokenizer.scanEntitiesFast()) {
    refs.push({
      expressId: ref.expressId,
      type: ref.type,
      byteOffset: ref.offset,
      byteLength: ref.length,
      lineNumber: ref.line,
    });
  }
  return new ColumnarParser().parseLite(buffer, refs, {});
}

const stepOf = (body: string[]) => [...HEADER, ...body, ...FOOTER].join('\n');

describe('IfcRelAssignsToProduct task outputs (#6749)', () => {
  it('extracts each task\'s output products, apart from its inputs', async () => {
    const data = extractScheduleOnDemand(await parseStep(stepOf(BODY)));
    const byGid = new Map(data.tasks.map(t => [t.globalId, t]));

    const slab = byGid.get('task-slab')!;
    expect(slab.productExpressIds).toEqual([]);
    expect(slab.outputProductExpressIds).toEqual([20]);
    expect(slab.outputProductGlobalIds).toEqual(['slab-1']);

    const wall = byGid.get('task-wall')!;
    expect(wall.productExpressIds).toEqual([23]);
    expect(wall.productGlobalIds).toEqual(['col-1']);
    // The repeated (task, product) relation is one identity edge.
    expect(wall.outputProductExpressIds).toEqual([21, 22]);
    expect(wall.outputProductGlobalIds).toEqual(['wall-1', 'wall-2']);

    // The union consumers read: inputs first, then outputs, index-aligned.
    expect(taskProductExpressIds(wall)).toEqual([23, 21, 22]);
    expect(taskProductGlobalIds(wall)).toEqual(['col-1', 'wall-1', 'wall-2']);

    // The parent carries no product of its own; the cost item's relation
    // to wall-1 attached nothing to any task.
    expect(byGid.get('task-ground')!.outputProductExpressIds).toBeUndefined();
  });

  it('round-trips outputs as IfcRelAssignsToProduct, not as inputs', async () => {
    const store = await parseStep(stepOf(BODY));
    const data = extractScheduleOnDemand(store);

    const result = serializeScheduleToStep(data, {
      nextId: 1000,
      resolveProductExpressId: gid => store.entities.getExpressIdByGlobalId(gid),
    });
    // slab-1, wall-1, wall-2 → one relation per output product.
    expect(result.stats.assignsToProduct).toBe(3);
    expect(result.stats.assignsToProcess).toBe(1);

    // Re-parse the products plus ONLY the serialized schedule, so every
    // relation read back is one the serializer wrote.
    const products = BODY.filter(l => /IFC(PROJECT|OWNERHISTORY|SLAB|WALL|COLUMN)\(/.test(l));
    const back = extractScheduleOnDemand(await parseStep(stepOf([...products, ...result.lines])));
    const byGid = new Map(back.tasks.map(t => [t.globalId, t]));
    expect(byGid.get('task-slab')!.outputProductGlobalIds).toEqual(['slab-1']);
    expect(byGid.get('task-slab')!.productGlobalIds).toEqual([]);
    expect(byGid.get('task-wall')!.outputProductGlobalIds).toEqual(['wall-1', 'wall-2']);
    expect(byGid.get('task-wall')!.productGlobalIds).toEqual(['col-1']);
  });

  it('groups tasks that output the same product into one relation', () => {
    const task = (globalId: string) => ({
      expressId: 0, globalId, name: globalId, isMilestone: false,
      childGlobalIds: [], productExpressIds: [], productGlobalIds: [],
      outputProductExpressIds: [21], outputProductGlobalIds: ['wall-1'],
      controllingScheduleGlobalIds: [],
    });
    const result = serializeScheduleToStep(
      { hasSchedule: true, workSchedules: [], sequences: [], tasks: [task('a'), task('b')] },
      { nextId: 1 },
    );
    const rels = result.lines.filter(l => l.includes('IFCRELASSIGNSTOPRODUCT'));
    expect(rels).toHaveLength(1);
    // Tasks a and b are #1 and #2; the relating product is the wall.
    expect(rels[0]).toMatch(/,\(#1,#2\),\$,#21\);$/);
  });
});
