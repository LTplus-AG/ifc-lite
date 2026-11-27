/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS partOf `relation` keeps IfcRelAggregates and IfcRelNests apart.
 *
 * The IDS user manual (partof-facet.md) lists them as distinct relations and
 * says that when `relation` is given "only the specified relation type should
 * be considered". The parser files IfcRelNests under the Aggregates edge
 * bucket (and also under RelationshipType.Nests), and the bridge mapped both
 * IDS relations onto Aggregates, so a nested element satisfied an
 * IfcRelAggregates requirement and an aggregated element satisfied an
 * IfcRelNests one. ifctester (IfcOpenShell 0.8.5) keeps them apart.
 */

import { describe, it, expect } from 'vitest';
import { StepTokenizer, ColumnarParser } from '@ifc-lite/parser';
import type { EntityRef } from '@ifc-lite/parser';
import { createDataAccessor } from './data-accessor.js';
import { checkPartOfFacet } from '../facets/partof-facet.js';
import type { IDSPartOfFacet, IDSSimpleValue } from '../types.js';

const sv = (value: string): IDSSimpleValue => ({ type: 'simpleValue', value });

async function parse(ifc: string) {
  const source = new TextEncoder().encode(ifc);
  const entityRefs: EntityRef[] = [];
  for (const ref of new StepTokenizer(source).scanEntitiesFast()) {
    entityRefs.push({ expressId: ref.expressId, type: ref.type, byteOffset: ref.offset, byteLength: ref.length, lineNumber: ref.line });
  }
  return new ColumnarParser().parseLite(source.buffer.slice(0) as ArrayBuffer, entityRefs, {});
}

// #100 is aggregated into #200; #110 is nested in #200.
const IFC = `#100=IFCCOLUMN('0Col000000000000000001',$,'Aggregated',$,$,$,$,$,$);
#110=IFCCOLUMN('0Col000000000000000002',$,'Nested',$,$,$,$,$,$);
#200=IFCELEMENTASSEMBLY('0Asm000000000000000001',$,'Whole',$,$,$,$,$,$);
#300=IFCRELAGGREGATES('0RelAgg000000000000001',$,$,$,#200,(#100));
#310=IFCRELNESTS('0RelNst000000000000001',$,$,$,#200,(#110));`;

const facet = (relation: IDSPartOfFacet['relation'], anyRelation = false): IDSPartOfFacet => ({
  type: 'partOf',
  relation,
  ...(anyRelation ? { anyRelation: true } : {}),
  entity: { type: 'entity', name: sv('IFCELEMENTASSEMBLY') },
});

describe('IDS partOf relation: IfcRelAggregates vs IfcRelNests', () => {
  it.each([
    ['IfcRelAggregates', 100, true],
    ['IfcRelAggregates', 110, false],
    ['IfcRelNests', 110, true],
    ['IfcRelNests', 100, false],
  ] as const)('%s on #%i passes=%s', async (relation, id, expected) => {
    const accessor = createDataAccessor(await parse(IFC));
    expect(checkPartOfFacet(facet(relation), id, accessor).passed).toBe(expected);
  });

  it('with no relation given, both count', async () => {
    const accessor = createDataAccessor(await parse(IFC));
    expect(checkPartOfFacet(facet('IfcRelAggregates', true), 100, accessor).passed).toBe(true);
    expect(checkPartOfFacet(facet('IfcRelAggregates', true), 110, accessor).passed).toBe(true);
  });
});
