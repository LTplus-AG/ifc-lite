/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `writeIdsXml` must refuse a facet shape `ids.xsd` 1.0 rejects (or cannot
 * carry) rather than write a file third-party tools reject. Found by
 * validating generated files with `xmllint --schema ids.xsd`:
 *   - `<partOf cardinality="optional">`: the XSD allows required|prohibited.
 *   - `<classification/>` with neither value nor system: the XSD needs one.
 *   - an entity requirement that is prohibited/optional: entity has no
 *     cardinality in IDS 1.0, so it was written as a plain (required) check.
 * These assert the structural property (a refusal), not the XSD run itself;
 * the XSD run lives in `audit/xsd/ids-xsd-conformance.test.ts`.
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

describe('writeIdsXml refuses shapes ids.xsd rejects', () => {
  const partOf: IDSFacet = { type: 'partOf', relation: 'IfcRelAggregates', entity: { type: 'entity', name: sv('IFCBUILDING') } };

  it('an optional partOf requirement', () => {
    expect(() => writeIdsXml(docWith(partOf, 'optional'))).toThrow(/partOf requirement cannot be optional/);
    expect(writeIdsXml(docWith(partOf, 'required'))).toContain('<partOf');
    expect(writeIdsXml(docWith(partOf, 'prohibited'))).toContain('cardinality="prohibited"');
  });

  it('a classification with neither value nor system, in requirements and applicability', () => {
    const empty: IDSFacet = { type: 'classification' };
    expect(() => writeIdsXml(docWith(empty, 'required'))).toThrow(/classification facet needs a value or a system/);
    const doc = docWith(entity('IFCWALL'), 'required');
    doc.specifications[0].applicability.facets = [empty];
    expect(() => writeIdsXml(doc)).toThrow(/classification facet needs a value or a system/);
    expect(writeIdsXml(docWith({ type: 'classification', system: sv('Uniclass') }, 'required'))).toContain('<system>');
  });

  it('a prohibited or optional entity requirement, which has no XML cardinality', () => {
    expect(() => writeIdsXml(docWith(entity('IFCDOOR'), 'prohibited'))).toThrow(/entity requirement cannot be prohibited/);
    expect(() => writeIdsXml(docWith(entity('IFCDOOR'), 'optional'))).toThrow(/entity requirement cannot be optional/);
    expect(writeIdsXml(docWith(entity('IFCDOOR'), 'required'))).toContain('<entity>');
  });
});
