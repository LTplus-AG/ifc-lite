/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #11461: Refuse conditions IDS 1.0 cannot express. The schema needs a
 * classification system and permits only required/prohibited partOf
 * requirements. An entity requirement always implies required.
 */

import { describe, expect, it } from 'vitest';
import type { IDSDocument, IDSFacet, RequirementOptionality } from '../types.js';
import { writeIdsXml } from './index.js';

const sv = (value: string) => ({ type: 'simpleValue', value }) as const;
const entity = (name: string): IDSFacet => ({ type: 'entity', name: sv(name) });

function docWith(facet: IDSFacet, optionality: RequirementOptionality): IDSDocument {
  return {
    info: { title: 'T' },
    specifications: [{
      id: 's', name: 'S', ifcVersions: ['IFC4'],
      applicability: { facets: [entity('IFCWALL')] },
      requirements: [{ id: 'r', facet, optionality }],
    }],
  };
}

describe('writeIdsXml refuses shapes IDS 1.0 cannot represent (#11461)', () => {
  const partOf: IDSFacet = { type: 'partOf', relation: 'IfcRelAggregates', entity: { type: 'entity', name: sv('IFCBUILDING') } };

  it('an optional partOf requirement', () => {
    expect(() => writeIdsXml(docWith(partOf, 'optional'))).toThrow(/partOf requirement cannot be optional/);
    expect(writeIdsXml(docWith(partOf, 'required'))).toContain('<partOf');
    expect(writeIdsXml(docWith(partOf, 'prohibited'))).toContain('cardinality="prohibited"');
  });

  it.each([
    { description: 'empty', facet: { type: 'classification' } },
    { description: 'value-only', facet: { type: 'classification', value: sv('Ss_25') } },
  ] satisfies { description: string; facet: IDSFacet }[])(
    'a $description classification requirement without a system',
    ({ facet }) => {
      expect(() => writeIdsXml(docWith(facet, 'required'))).toThrow(/classification facet needs a system/);
    },
  );

  it('a value-only classification in applicability', () => {
    const doc = docWith(entity('IFCWALL'), 'required');
    doc.specifications[0].applicability.facets = [{ type: 'classification', value: sv('Ss_25') }];
    expect(() => writeIdsXml(doc)).toThrow(/classification facet needs a system/);
  });

  it('a classification with a system and no value is writable', () => {
    expect(writeIdsXml(docWith({ type: 'classification', system: sv('Uniclass') }, 'required'))).toContain('<system>');
  });

  it('a prohibited or optional entity requirement, which has no XML cardinality', () => {
    expect(() => writeIdsXml(docWith(entity('IFCDOOR'), 'prohibited'))).toThrow(/entity requirement cannot be prohibited/);
    expect(() => writeIdsXml(docWith(entity('IFCDOOR'), 'optional'))).toThrow(/entity requirement cannot be optional/);
    expect(writeIdsXml(docWith(entity('IFCDOOR'), 'required'))).toContain('<entity>');
  });
});
