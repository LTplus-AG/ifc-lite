/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A partOf facet without a `relation` (#7401). The IDS 1.0 user manual
 * (partof-facet.md) says that then "all 6 are to be considered
 * (recursively)", and its examples table gives this exact case: a mullion
 * is partOf a curtain wall with `Entity="IFCCURTAINWALL"` and no relation.
 * The parser used to read a missing relation as
 * IfcRelContainedInSpatialStructure, so the mullion failed.
 *
 * Checked against a REAL parsed store, so the relationship graph the bridge
 * walks is the one the parser builds. None of the buildingSMART partOf
 * cases leaves the relation out, so the conformance corpus cannot catch it.
 */

import { describe, it, expect } from 'vitest';
import { StepTokenizer, ColumnarParser } from '@ifc-lite/parser';
import type { EntityRef } from '@ifc-lite/parser';
import { createDataAccessor } from './data-accessor.js';
import { createMockAccessor } from '../facets/test-helpers.js';
import { checkPartOfFacet } from '../facets/partof-facet.js';
import { parseIDS } from '../parser/xml-parser.js';
import { validateIDS } from '../validation/validator.js';
import type { IDSPartOfFacet, PartOfRelation } from '../types.js';

async function parse(ifc: string) {
  const source = new TextEncoder().encode(ifc);
  const tokenizer = new StepTokenizer(source);
  const entityRefs: EntityRef[] = [];
  for (const ref of tokenizer.scanEntitiesFast()) {
    entityRefs.push({
      expressId: ref.expressId,
      type: ref.type,
      byteOffset: ref.offset,
      byteLength: ref.length,
      lineNumber: ref.line,
    });
  }
  const parser = new ColumnarParser();
  return parser.parseLite(source.buffer.slice(0) as ArrayBuffer, entityRefs, {});
}

// Mullion #11 is aggregated into curtain wall #10, which the storey contains.
// Window #22 fills opening #21, which voids wall #20, which the storey
// contains: the window reaches the storey only through a chain of three
// different relations, and nothing contains it directly.
const IFC = `#1=IFCBUILDINGSTOREY('0Storey000000000000001',$,'Storey',$,$,$,$,$,.ELEMENT.,0.);
#10=IFCCURTAINWALL('0Curtain00000000000001',$,'CW-1',$,$,$,$,$,$);
#11=IFCMEMBER('0Member000000000000001',$,'Mullion',$,$,$,$,$,.MULLION.);
#12=IFCRELAGGREGATES('0RelAgg000000000000001',$,$,$,#10,(#11));
#20=IFCWALL('0Wall00000000000000001',$,'W-1',$,$,$,$,$,$);
#21=IFCOPENINGELEMENT('0Opening00000000000001',$,'O-1',$,$,$,$,$,.OPENING.);
#22=IFCWINDOW('0Window000000000000001',$,'Win-1',$,$,$,$,$,$,$,$,$,$);
#23=IFCRELVOIDSELEMENT('0RelVoid00000000000001',$,$,$,#20,#21);
#24=IFCRELFILLSELEMENT('0RelFill00000000000001',$,$,$,#21,#22);
#25=IFCRELCONTAINEDINSPATIALSTRUCTURE('0RelCont00000000000001',$,$,$,(#10,#20),#1);`;

const MULLION = 11;
const WINDOW = 22;

function partOf(entity: string, relation?: PartOfRelation): IDSPartOfFacet {
  return {
    type: 'partOf',
    ...(relation ? { relation } : {}),
    entity: { type: 'entity', name: { type: 'simpleValue', value: entity } },
  };
}

describe('IDS partOf without a relation follows every relation, recursively (#7401)', () => {
  it('passes a mullion aggregated into a curtain wall', async () => {
    const accessor = createDataAccessor(await parse(IFC));
    const result = checkPartOfFacet(partOf('IFCCURTAINWALL'), MULLION, accessor);
    expect(result.passed).toBe(true);
    expect(result.actualValue).toBe('part of IfcCurtainWall');
  });

  it('still fails when no relation links the element to that class', async () => {
    const accessor = createDataAccessor(await parse(IFC));
    const result = checkPartOfFacet(partOf('IFCWALL'), MULLION, accessor);
    expect(result.passed).toBe(false);
    expect(result.failure?.type).toBe('PARTOF_ENTITY_MISMATCH');
    // No relation was named, so none is reported.
    expect(result.failure?.context).not.toHaveProperty('relation');
  });

  it('follows a chain that mixes relations: a window in an opening of a contained wall is part of the storey', async () => {
    const accessor = createDataAccessor(await parse(IFC));
    expect(checkPartOfFacet(partOf('IFCBUILDINGSTOREY'), WINDOW, accessor).passed).toBe(true);
    expect(checkPartOfFacet(partOf('IFCWALL'), WINDOW, accessor).passed).toBe(true);
  });

  it('keeps a named relation to that relation alone', async () => {
    const accessor = createDataAccessor(await parse(IFC));
    const contained = 'IfcRelContainedInSpatialStructure';
    expect(checkPartOfFacet(partOf('IFCCURTAINWALL', contained), MULLION, accessor).passed).toBe(false);
    expect(checkPartOfFacet(partOf('IFCBUILDINGSTOREY', contained), WINDOW, accessor).passed).toBe(false);
    expect(checkPartOfFacet(partOf('IFCCURTAINWALL', 'IfcRelAggregates'), MULLION, accessor).passed).toBe(true);
  });

  it('walks getParent per relation for an accessor without getAncestors', () => {
    // A member aggregated into a curtain wall that a storey contains, seen
    // through an accessor that only implements single-step `getParent`.
    const accessor = createMockAccessor([
      { expressId: 1, type: 'IfcMember', parent: { expressId: 2, type: 'IfcCurtainWall', relation: 'IfcRelAggregates' } },
      { expressId: 2, type: 'IfcCurtainWall', parent: { expressId: 3, type: 'IfcBuildingStorey', relation: 'IfcRelContainedInSpatialStructure' } },
      { expressId: 3, type: 'IfcBuildingStorey' },
    ]);
    expect(accessor.getAncestors).toBeUndefined();
    expect(checkPartOfFacet(partOf('IFCCURTAINWALL'), 1, accessor).passed).toBe(true);
    expect(checkPartOfFacet(partOf('IFCBUILDINGSTOREY'), 1, accessor).passed).toBe(true);
    expect(checkPartOfFacet(partOf('IFCWALL'), 1, accessor).passed).toBe(false);
  });

  it('passes the issue reproduction end to end, from the IDS text', async () => {
    const store = await parse(IFC);
    const doc = parseIDS(`<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <info><title>partOf without a relation</title></info>
  <specifications>
    <specification name="Mullions belong to a curtain wall" ifcVersion="IFC4">
      <applicability minOccurs="0" maxOccurs="unbounded"><entity><name><simpleValue>IFCMEMBER</simpleValue></name></entity></applicability>
      <requirements><partOf><entity><name><simpleValue>IFCCURTAINWALL</simpleValue></name></entity></partOf></requirements>
    </specification>
  </specifications>
</ids>`);
    const report = await validateIDS(doc, createDataAccessor(store), {
      modelId: 'm',
      schemaVersion: 'IFC4',
      entityCount: 10,
    }, { includePassingEntities: true });
    const [spec] = report.specificationResults;
    expect(spec.applicableCount).toBe(1);
    expect(spec.status).toBe('pass');
    expect(spec.entityResults.map((e) => [e.entityName, e.passed])).toEqual([['Mullion', true]]);
  });
});
