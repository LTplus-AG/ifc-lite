/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * An unset PredefinedType must not fall back to the ObjectType (#7394).
 *
 * IDS 1.0 lets the user-defined name stand in for the predefined type only
 * when the PredefinedType is USERDEFINED. `matchPredefinedType` also fell
 * back to the ObjectType whenever no raw token was reported, a branch meant
 * for accessors that cannot look the raw token up. The bridge's accessor
 * can, and reports none for an unset PredefinedType (on the element and its
 * type), so a beam with PredefinedType `$` and ObjectType `X` passed a
 * requirement for predefined type `X`.
 *
 * Checked against a REAL parsed store, so the raw token and the inheritance
 * from the type object are the ones the bridge resolves.
 */

import { describe, it, expect } from 'vitest';
import { StepTokenizer, ColumnarParser } from '@ifc-lite/parser';
import type { EntityRef } from '@ifc-lite/parser';
import { createDataAccessor } from './data-accessor.js';
import { checkEntityFacet } from '../facets/entity-facet.js';
import { checkPartOfFacet } from '../facets/partof-facet.js';
import { parseIDS } from '../parser/xml-parser.js';
import { validateIDS } from '../validation/validator.js';
import type { IDSEntityFacet, IDSPartOfFacet } from '../types.js';

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

// B-1: PredefinedType unset, ObjectType X. B-2: USERDEFINED, ObjectType X.
// B-3: NOTDEFINED, ObjectType X. B-4: unset, typed by a beam type that is
// USERDEFINED with ElementType X, so it inherits both. Member #20 is
// aggregated into B-1, member #21 into B-2.
const IFC = `#1=IFCBEAM('0Beam000000000000000001',$,'B-1',$,'X',$,$,'B-1',$);
#2=IFCBEAM('0Beam000000000000000002',$,'B-2',$,'X',$,$,'B-2',.USERDEFINED.);
#3=IFCBEAM('0Beam000000000000000003',$,'B-3',$,'X',$,$,'B-3',.NOTDEFINED.);
#4=IFCBEAM('0Beam000000000000000004',$,'B-4',$,$,$,$,'B-4',$);
#5=IFCBEAMTYPE('0BeamType0000000000001',$,'BT',$,$,$,$,$,'X',.USERDEFINED.);
#6=IFCRELDEFINESBYTYPE('0RelType00000000000001',$,$,$,(#4),#5);
#20=IFCMEMBER('0Member000000000000001',$,'M-1',$,$,$,$,$,$);
#21=IFCMEMBER('0Member000000000000002',$,'M-2',$,$,$,$,$,$);
#22=IFCRELAGGREGATES('0RelAgg000000000000001',$,$,$,#1,(#20));
#23=IFCRELAGGREGATES('0RelAgg000000000000002',$,$,$,#2,(#21));`;

const beamX: IDSEntityFacet = {
  type: 'entity',
  name: { type: 'simpleValue', value: 'IFCBEAM' },
  predefinedType: { type: 'simpleValue', value: 'X' },
};

describe('an unset PredefinedType does not fall back to the ObjectType (#7394)', () => {
  it('fails a beam whose PredefinedType is unset, whatever its ObjectType says', async () => {
    const accessor = createDataAccessor(await parse(IFC));
    const result = checkEntityFacet(beamX, 1, accessor);
    expect(result.passed).toBe(false);
    expect(result.failure?.type).toBe('PREDEFINED_TYPE_MISSING');
  });

  it('still reads the ObjectType for USERDEFINED, and for a USERDEFINED type object', async () => {
    const accessor = createDataAccessor(await parse(IFC));
    expect(checkEntityFacet(beamX, 2, accessor).passed).toBe(true);
    expect(checkEntityFacet(beamX, 3, accessor).passed).toBe(false);
    expect(checkEntityFacet(beamX, 4, accessor).passed).toBe(true);
  });

  it('applies the same rule to the entity nested in a partOf facet', async () => {
    const accessor = createDataAccessor(await parse(IFC));
    const partOfBeamX: IDSPartOfFacet = { type: 'partOf', relation: 'IfcRelAggregates', entity: beamX };
    expect(checkPartOfFacet(partOfBeamX, 20, accessor).passed).toBe(false);
    expect(checkPartOfFacet(partOfBeamX, 21, accessor).passed).toBe(true);
  });

  it('fails the issue reproduction end to end, from the IDS text', async () => {
    const store = await parse(IFC);
    const doc = parseIDS(`<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <info><title>predefined type X</title></info>
  <specifications>
    <specification name="Beams of type X" ifcVersion="IFC4">
      <applicability minOccurs="0" maxOccurs="unbounded"><entity><name><simpleValue>IFCBEAM</simpleValue></name></entity></applicability>
      <requirements><entity><name><simpleValue>IFCBEAM</simpleValue></name><predefinedType><simpleValue>X</simpleValue></predefinedType></entity></requirements>
    </specification>
  </specifications>
</ids>`);
    const report = await validateIDS(doc, createDataAccessor(store), {
      modelId: 'm',
      schemaVersion: 'IFC4',
      entityCount: 10,
    }, { includePassingEntities: true });
    const verdicts = Object.fromEntries(report.specificationResults[0].entityResults.map((e) => [e.entityName, e.passed]));
    expect(verdicts).toEqual({ 'B-1': false, 'B-2': true, 'B-3': false, 'B-4': true });
  });
});
