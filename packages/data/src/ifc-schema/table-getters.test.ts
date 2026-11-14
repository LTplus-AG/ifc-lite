/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Every exported schema-table constant is the very object its getter returns,
 * so code that switched from the constant to the getter (to keep the viewer's
 * startup chunks from decoding tables at load) reads the same arrays, in the
 * same order.
 */

import { describe, it, expect } from 'vitest';
import * as attributes from './generated/attributes.js';
import * as dataTypes from './generated/data-types.js';
import * as e2x3 from './generated/entities-ifc2x3.js';
import * as e4 from './generated/entities-ifc4.js';
import * as e4x3 from './generated/entities-ifc4x3.js';
import * as p2x3 from './generated/psets-ifc2x3.js';
import * as p4 from './generated/psets-ifc4.js';
import * as p4x3 from './generated/psets-ifc4x3.js';
import * as express from './entities-ifc4-express.js';
import { eagerSchemaTablesEvaluated } from './table-codec.js';

const PAIRS: Array<[string, unknown, () => unknown]> = [
  ['ATTRIBUTES_IFC2X3', attributes.ATTRIBUTES_IFC2X3, attributes.getAttributesIfc2x3],
  ['ATTRIBUTES_IFC4', attributes.ATTRIBUTES_IFC4, attributes.getAttributesIfc4],
  ['ATTRIBUTES_IFC4X3', attributes.ATTRIBUTES_IFC4X3, attributes.getAttributesIfc4x3],
  ['IFC_DATA_TYPES', dataTypes.IFC_DATA_TYPES, dataTypes.getIfcDataTypes],
  ['ENTITIES_IFC2X3', e2x3.ENTITIES_IFC2X3, e2x3.getEntitiesIfc2x3],
  ['ENTITIES_IFC4', e4.ENTITIES_IFC4, e4.getEntitiesIfc4],
  ['ENTITIES_IFC4X3', e4x3.ENTITIES_IFC4X3, e4x3.getEntitiesIfc4x3],
  ['PROPERTY_SETS_IFC2X3', p2x3.PROPERTY_SETS_IFC2X3, p2x3.getPropertySetsIfc2x3],
  ['PROPERTY_SETS_IFC4', p4.PROPERTY_SETS_IFC4, p4.getPropertySetsIfc4],
  ['PROPERTY_SETS_IFC4X3', p4x3.PROPERTY_SETS_IFC4X3, p4x3.getPropertySetsIfc4x3],
  ['ENTITIES_IFC4_EXPRESS', express.ENTITIES_IFC4_EXPRESS, express.getEntitiesIfc4Express],
];

describe('schema table getters', () => {
  for (const [name, constant, getter] of PAIRS) {
    it(`${name}: the getter returns the constant itself, every call`, () => {
      expect(getter()).toBe(constant);
      expect(getter()).toBe(getter());
      expect(Array.isArray(constant) && constant.length > 0).toBe(true);
    });
  }

  it('records the marker of every constant evaluated in this realm', () => {
    const evaluated = eagerSchemaTablesEvaluated();
    for (const [name] of PAIRS) expect(evaluated).toContain(`ifc-lite-eager-table:${name}`);
  });
});
