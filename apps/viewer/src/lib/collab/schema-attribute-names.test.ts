/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser } from '@ifc-lite/parser';
import { attributeNamesForStore, referenceAttributeSlotsForStore } from './schema-attribute-names.js';

const IFC4 = `ISO-10303-21;
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('m','2026',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;#1=IFCPROJECT('0000000000000000000001',$,'Project',$,$,$,$,$,$);ENDSEC;END-ISO-10303-21;`;

test('reference slots follow the cross-schema attribute names for a class the file schema lacks (#5008 review)', async () => {
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(IFC4).buffer as ArrayBuffer);
  // IfcSolidStratum exists only in IFC4X3; an IFC4 store still names its attributes cross-schema.
  const names = attributeNamesForStore(store, 'IfcSolidStratum');
  const slots = referenceAttributeSlotsForStore(store, 'IfcSolidStratum');
  assert.equal(slots.length, names.length);
  assert.equal(slots[names.indexOf('OwnerHistory')], true, 'OwnerHistory is an entity reference');
  assert.equal(slots[names.indexOf('ObjectPlacement')], true, 'ObjectPlacement is an entity reference');
  assert.equal(slots[names.indexOf('Name')], false);

  // A class the file schema declares keeps its own registry's answer.
  const wallNames = attributeNamesForStore(store, 'IfcWall');
  assert.equal(referenceAttributeSlotsForStore(store, 'IfcWall')[wallNames.indexOf('Representation')], true);
});
