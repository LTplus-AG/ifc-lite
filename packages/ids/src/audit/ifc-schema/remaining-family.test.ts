/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS-008, the last two `invalid-` families: a prohibited specification with
 * requirements, and a predefinedType on an entity that has none (neither on
 * itself nor on its type object). The corpus files are the negative fixtures;
 * these pin the valid side of each boundary.
 */

import { describe, expect, it } from 'vitest';
import { auditIDSDocument } from '../index.js';

function spec(body: string, version = 'IFC4', occurs = 'minOccurs="1" maxOccurs="unbounded"'): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <info><title>Remaining family</title></info>
  <specifications>
    <specification name="S" ifcVersion="${version}">
      <applicability ${occurs}>${body}</applicability>
    </specification>
  </specifications>
</ids>`;
}

const wall = '<entity><name><simpleValue>IFCWALL</simpleValue></name></entity>';

async function errorCodes(xml: string): Promise<string[]> {
  return (await auditIDSDocument(xml)).issues.filter((i) => i.severity === 'error').map((i) => i.code);
}

describe('prohibited specifications and predefined types (IDS-008)', () => {
  it('a prohibited specification may have no requirements, but not some', async () => {
    const prohibited = 'minOccurs="0" maxOccurs="0"';
    expect(await errorCodes(spec(wall, 'IFC4', prohibited))).toEqual([]);
    const withRequirements = spec(wall, 'IFC4', prohibited).replace('</specification>',
      '<requirements><attribute><name><simpleValue>Name</simpleValue></name></attribute></requirements></specification>');
    expect(await errorCodes(withRequirements)).toEqual(['E_CARDINALITY_INVALID']);
  });

  it('an IFC2X3 occurrence takes its predefined types from its type object', async () => {
    const typed = '<entity><name><simpleValue>IFCWALL</simpleValue></name><predefinedType><simpleValue>SHEAR</simpleValue></predefinedType></entity>';
    expect(await errorCodes(spec(typed, 'IFC2X3'))).toEqual([]);
  });

  it('flags a predefinedType on an entity with no PredefinedType and no type object', async () => {
    const inventory = '<entity><name><simpleValue>IFCINVENTORY</simpleValue></name><predefinedType><simpleValue>ASSETINVENTORY</simpleValue></predefinedType></entity>';
    expect(await errorCodes(spec(inventory, 'IFC2X3'))).toEqual(['E_IFC_PREDEF_TYPE_INVALID']);
    expect(await errorCodes(spec(inventory, 'IFC4'))).toEqual([]);
  });
});
