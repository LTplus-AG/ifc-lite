/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #7394: an unset (or NOTDEFINED) PredefinedType must not fall back to the
 * ObjectType. IDS 1.0 reads the ObjectType / ElementType only when the
 * PredefinedType that applies is USERDEFINED, and takes that applicable
 * PredefinedType from the type object first, then the occurrence (User
 * Manual, entity facet, "The logic for the identification of
 * predefinedType").
 *
 * The attribute facet is a different construct: `<attribute><name>
 * PredefinedType</name>` tests the attribute as stored on the entity, not
 * the entity facet's resolved value.
 *
 * Both run here through a real parsed store and the production accessor,
 * since the fallback lived in the accessor, not in the shared matcher.
 */

import { describe, it, expect } from 'vitest';
import { StepTokenizer, ColumnarParser } from '@ifc-lite/parser';
import type { EntityRef } from '@ifc-lite/parser';
import { createDataAccessor } from './data-accessor.js';
import { checkEntityFacet, entityFacetPasses } from '../facets/entity-facet.js';
import { checkAttributeFacet } from '../facets/attribute-facet.js';
import type { IDSAttributeFacet, IDSEntityFacet, IDSSimpleValue } from '../types.js';

const sv = (value: string): IDSSimpleValue => ({ type: 'simpleValue', value });

async function accessorFor(ifc: string) {
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
  const store = await new ColumnarParser().parseLite(
    source.buffer.slice(0) as ArrayBuffer,
    entityRefs,
    {}
  );
  return createDataAccessor(store);
}

const beamWith = (predefinedType: string): IDSEntityFacet => ({
  type: 'entity',
  name: sv('IFCBEAM'),
  predefinedType: sv(predefinedType),
});

/** Both entity-facet entry points must agree (validation-scale pins this too). */
async function entityVerdict(ifc: string, id: number, predefinedType: string) {
  const accessor = await accessorFor(ifc);
  const facet = beamWith(predefinedType);
  const passed = checkEntityFacet(facet, id, accessor).passed;
  expect(entityFacetPasses(facet, id, accessor)).toBe(passed);
  return passed;
}

// IFC4 IfcBeam: GlobalId, OwnerHistory, Name, Description, ObjectType,
// ObjectPlacement, Representation, Tag, PredefinedType.
const UNSET = `#20=IFCBEAM('3vB2YO$MX4xv5uCqZZG1a0',$,'B-1',$,'X',$,$,'B-1',$);`;
const NOTDEFINED = `#20=IFCBEAM('3vB2YO$MX4xv5uCqZZG1a0',$,'B-1',$,'X',$,$,'B-1',.NOTDEFINED.);`;
const USERDEFINED = `#20=IFCBEAM('3vB2YO$MX4xv5uCqZZG1a0',$,'B-1',$,'X',$,$,'B-1',.USERDEFINED.);`;

// IFC4 IfcBeamType: GlobalId, OwnerHistory, Name, Description,
// ApplicableOccurrence, HasPropertySets, RepresentationMaps, Tag,
// ElementType, PredefinedType.
const typed = (occurrencePdt: string, typeElementType: string, typePdt: string) =>
  [
    `#20=IFCBEAM('3vB2YO$MX4xv5uCqZZG1a0',$,'B-1',$,'OCC',$,$,$,${occurrencePdt});`,
    `#30=IFCBEAMTYPE('0eA6m4fELI9QBIhP3wiLAp',$,'BT',$,$,$,$,$,${typeElementType},${typePdt});`,
    `#40=IFCRELDEFINESBYTYPE('05rScmOVzMoQXOfbYdtLYj',$,$,$,(#20),#30);`,
  ].join('\n');

describe('IDS entity facet predefinedType: no ObjectType fallback (#7394)', () => {
  it('an unset PredefinedType does not match the ObjectType', async () => {
    expect(await entityVerdict(UNSET, 20, 'X')).toBe(false);
  });

  it('a NOTDEFINED PredefinedType does not match the ObjectType', async () => {
    expect(await entityVerdict(NOTDEFINED, 20, 'X')).toBe(false);
  });

  it('USERDEFINED reads the ObjectType, and still matches the literal USERDEFINED', async () => {
    expect(await entityVerdict(USERDEFINED, 20, 'X')).toBe(true);
    expect(await entityVerdict(USERDEFINED, 20, 'USERDEFINED')).toBe(true);
  });

  it('inherits a concrete PredefinedType from the type object', async () => {
    const ifc = typed('.NOTDEFINED.', '$', '.HOLLOWCORE.');
    expect(await entityVerdict(ifc, 20, 'HOLLOWCORE')).toBe(true);
    expect(await entityVerdict(ifc, 20, 'OCC')).toBe(false);
  });

  it("a USERDEFINED type object reads the TYPE's ElementType, not the occurrence's ObjectType", async () => {
    const ifc = typed('$', "'T'", '.USERDEFINED.');
    expect(await entityVerdict(ifc, 20, 'T')).toBe(true);
    expect(await entityVerdict(ifc, 20, 'OCC')).toBe(false);
  });

  it('a NOTDEFINED type object defers to the occurrence', async () => {
    expect(await entityVerdict(typed('.USERDEFINED.', '$', '.NOTDEFINED.'), 20, 'OCC')).toBe(true);
    expect(await entityVerdict(typed('$', "'T'", '.NOTDEFINED.'), 20, 'OCC')).toBe(false);
  });
});

describe('IDS attribute facet name=PredefinedType reads the stored attribute (#7394)', () => {
  const attr = (value?: string): IDSAttributeFacet => ({
    type: 'attribute',
    name: sv('PredefinedType'),
    ...(value === undefined ? {} : { value: sv(value) }),
  });

  it('an unset PredefinedType is a missing attribute, whatever the ObjectType says', async () => {
    const accessor = await accessorFor(UNSET);
    expect(checkAttributeFacet(attr(), 20, accessor).passed).toBe(false);
    expect(checkAttributeFacet(attr('X'), 20, accessor).passed).toBe(false);
  });

  it('a USERDEFINED PredefinedType is the token USERDEFINED, not the ObjectType', async () => {
    const accessor = await accessorFor(USERDEFINED);
    expect(checkAttributeFacet(attr('USERDEFINED'), 20, accessor).passed).toBe(true);
    expect(checkAttributeFacet(attr('X'), 20, accessor).passed).toBe(false);
  });

  it("NOTDEFINED is the stored value, not replaced by the type object's", async () => {
    const accessor = await accessorFor(typed('.NOTDEFINED.', '$', '.HOLLOWCORE.'));
    expect(checkAttributeFacet(attr('NOTDEFINED'), 20, accessor).passed).toBe(true);
    expect(checkAttributeFacet(attr('HOLLOWCORE'), 20, accessor).passed).toBe(false);
  });
});
