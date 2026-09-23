/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5224: "no dataType" used to mean "skip the dataType check", so a facet
 * demanding IFCBOOLEAN passed `"not-a-boolean-at-all"`. An unknown dataType
 * now FAILS a dataType-constrained facet, with PROPERTY_DATATYPE_UNKNOWN, and
 * that failure holds even under a prohibition. The one exemption is explicit:
 * `dataTypeMixed` (an IfcPropertyTableValue) defers to the value match.
 *
 * Both gates are exercised. `checkPropertyFacet` and its diagnostics-free twin
 * `propertyFacetPasses` must agree, and they used to agree on the bug too.
 */

import { IfcParser } from '@ifc-lite/parser';
import { checkPropertyFacet, propertyFacetPasses } from './property-facet.js';
import { createDataAccessor } from '../bridge/data-accessor.js';
import { validateIDS } from '../validation/validator.js';
import type {
  IFCDataAccessor,
  IDSDocument,
  IDSPropertyFacet,
  IDSSimpleValue,
  PropertySetInfo,
  RequirementOptionality,
} from '../types.js';

const sv = (value: string): IDSSimpleValue => ({ type: 'simpleValue', value });

/** Returns exactly the `PropertySetInfo` given, with nothing defaulted. */
function accessorFor(psets: PropertySetInfo[]): IFCDataAccessor {
  return {
    getEntityType: () => 'IfcWall',
    getEntityName: () => undefined,
    getGlobalId: () => undefined,
    getDescription: () => undefined,
    getObjectType: () => undefined,
    getEntitiesByType: () => [1],
    getAllEntityIds: () => [1],
    getPropertyValue: () => undefined,
    getPropertySets: () => psets,
    getClassifications: () => [],
    getMaterials: () => [],
    getParent: () => undefined,
    getAttribute: () => undefined,
  };
}

const isExternal = (dataType: string | undefined): PropertySetInfo[] => [
  { name: 'Pset_Foo', properties: [{ name: 'IsExternal', value: 'not-a-boolean-at-all', dataType }] },
];
const booleanFacet: IDSPropertyFacet = {
  type: 'property',
  propertySet: sv('Pset_Foo'),
  baseName: sv('IsExternal'),
  dataType: sv('IFCBOOLEAN'),
};

describe('property facet dataType gate (#5224)', () => {
  it('an unknown dataType fails the facet as PROPERTY_DATATYPE_UNKNOWN, in both gates', () => {
    const accessor = accessorFor(isExternal(undefined));
    const result = checkPropertyFacet(booleanFacet, 1, accessor);
    expect(result.passed).toBe(false);
    expect(result.failure?.type).toBe('PROPERTY_DATATYPE_UNKNOWN');
    expect(propertyFacetPasses(booleanFacet, 1, accessor)).toBe(false);
  });

  it('a known wrong dataType is still PROPERTY_DATATYPE_MISMATCH', () => {
    const accessor = accessorFor(isExternal('IFCLABEL'));
    expect(checkPropertyFacet(booleanFacet, 1, accessor).failure?.type).toBe('PROPERTY_DATATYPE_MISMATCH');
    expect(propertyFacetPasses(booleanFacet, 1, accessor)).toBe(false);
  });

  it('a table (dataTypeMixed) defers to the value match against its candidates', () => {
    const psets: PropertySetInfo[] = [{
      name: 'Pset_Foo',
      properties: [{ name: 'MixedTable', value: 'Table (2 rows)', dataType: undefined, dataTypeMixed: true, values: ['true', '42'] }],
    }];
    const facet: IDSPropertyFacet = { ...booleanFacet, baseName: sv('MixedTable'), value: sv('true') };
    expect(checkPropertyFacet(facet, 1, accessorFor(psets)).passed).toBe(true);
    expect(propertyFacetPasses(facet, 1, accessorFor(psets))).toBe(true);
    // The same shape WITHOUT the flag is just an unknown type.
    const unflagged = [{ ...psets[0], properties: [{ ...psets[0].properties[0], dataTypeMixed: undefined }] }];
    expect(checkPropertyFacet(facet, 1, accessorFor(unflagged)).failure?.type).toBe('PROPERTY_DATATYPE_UNKNOWN');
  });

  it.each<RequirementOptionality>(['required', 'optional', 'prohibited'])(
    'an unknown dataType fails the requirement when it is %s: "cannot verify" is never a pass',
    async (optionality) => {
      const document: IDSDocument = {
        info: { title: '#5224' },
        specifications: [{
          id: 's', name: 's', ifcVersions: ['IFC4'],
          applicability: { facets: [{ type: 'entity', name: sv('IFCWALL') }] },
          requirements: [{ id: 'r', facet: booleanFacet, optionality }],
        }],
      };
      const report = await validateIDS(document, accessorFor(isExternal(undefined)), {
        modelId: 'm', schemaVersion: 'IFC4', entityCount: 1,
      });
      const r = report.specificationResults[0].entityResults[0].requirementResults[0];
      expect(r.status).toBe('fail');
      expect(r.failure?.type).toBe('PROPERTY_DATATYPE_UNKNOWN');
      expect(r.failureReason).toMatch(/no known data type/);
    },
  );
});

describe('parsed property dataTypes reach the gate (#5224)', () => {
  const IFC = (props: string) => `ISO-10303-21;
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('t','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;
#1=IFCWALL('0Wall0000000000000001A',$,'W',$,$,$,$,$,$);
${props}
#20=IFCPROPERTYSET('0Pset000000000000020A',$,'Foo_Bar',$,(#10));
#21=IFCRELDEFINESBYPROPERTIES('0Rel0000000000000021A',$,$,$,(#1),#20);
ENDSEC;
END-ISO-10303-21;
`;
  async function passes(props: string, dataType: string, value: string): Promise<boolean> {
    const bytes = new TextEncoder().encode(IFC(props));
    const store = await new IfcParser().parseColumnar(bytes.buffer.slice(0), { disableWorkerScan: true });
    const facet: IDSPropertyFacet = {
      type: 'property', propertySet: sv('Foo_Bar'), baseName: sv('Foo'), dataType: sv(dataType), value: sv(value),
    };
    return checkPropertyFacet(facet, 1, createDataAccessor(store)).passed;
  }

  it('a list and an enumeration carry the type all their members share', async () => {
    const list = `#10=IFCPROPERTYLISTVALUE('Foo',$,(IFCLABEL('X'),IFCLABEL('Y')),$);`;
    expect(await passes(list, 'IFCLABEL', 'Y')).toBe(true);
    expect(await passes(list, 'IFCTEXT', 'Y')).toBe(false);
    const enumerated = `#10=IFCPROPERTYENUMERATEDVALUE('Foo',$,(IFCLABEL('A')),$);`;
    expect(await passes(enumerated, 'IFCLABEL', 'A')).toBe(true);
    expect(await passes(enumerated, 'IFCBOOLEAN', 'A')).toBe(false);
  });

  it('a list whose members disagree on type has no dataType, so a dataType check fails', async () => {
    const mixed = `#10=IFCPROPERTYLISTVALUE('Foo',$,(IFCLABEL('X'),IFCTEXT('Y')),$);`;
    expect(await passes(mixed, 'IFCLABEL', 'X')).toBe(false);
  });

  it('a table stays exempt: the value decides', async () => {
    const table = `#10=IFCPROPERTYTABLEVALUE('Foo',$,(IFCLABEL('X')),(IFCLENGTHMEASURE(1000.)),$,$,$,$);`;
    expect(await passes(table, 'IFCLABEL', 'X')).toBe(true);
    expect(await passes(table, 'IFCLABEL', 'Z')).toBe(false);
  });
});
