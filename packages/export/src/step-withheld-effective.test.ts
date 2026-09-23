/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { buildExportPass } from './step-pass-builder.js';

it('IFC2X3 STEP pass withholds live material resources, not tombstoned source rows (#5249)', async () => {
  const source = [
    'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('','',(''),(''),'','','');", "FILE_SCHEMA(('IFC4'));", 'ENDSEC;',
    'DATA;',
    "#1=IFCPROJECT('0WithheldProject000000',$,'Project',$,$,$,$,$,$);",
    "#2=IFCMATERIALPROFILE('Old profile',$,$,$,$,$);",
    'ENDSEC;', 'END-ISO-10303-21;', '',
  ].join('\n');
  const bytes = new TextEncoder().encode(source);
  const store = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer);
  const view = new MutablePropertyView(null, 'model');
  const editor = new StoreEditor(store, view);
  const created = editor.addEntity('IfcMaterialProfile', ['New profile', null, null, null, null, null]);
  editor.removeEntity(2);

  const pass = (applyMutations: boolean) => buildExportPass({
    dataStore: store,
    mutationView: view,
    isGeometryEntity: () => false,
    options: { schema: 'IFC2X3' },
    schema: 'IFC2X3',
    sourceSchema: 'IFC4',
    converting: true,
    applyMutations,
    excludeGeometry: false,
    sourceHeader: undefined,
    schemaToken: 'IFC2X3',
  });

  expect([...pass(true).withheldRefIds]).toEqual([created.expressId]);
  expect([...pass(false).withheldRefIds]).toEqual([2]);
});
