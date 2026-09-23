/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * github.com/LTplus-AG/ifc-lite/issues/5199: `HasProperties` /
 * `IfcElementQuantity.Quantities` are declared `SET [1:?]` in every bundled
 * schema — not OPTIONAL — so an empty aggregate is not a neutral encoding of
 * "no properties yet"; it is a DIFFERENT invalid file than the `$` a naive
 * fix might reach for instead. `createPropertySet`/`addPropertySet` and
 * `createQuantitySet`/`addQuantitySet` legitimately accept a zero-length
 * array as a placeholder to be filled in later — `change-set-to-ops.ts` has
 * dedicated handling for exactly this session state, and
 * `effective-changes.test.ts` / `publish.test.ts` both pin it as intentional
 * — so the fix cannot be "refuse at creation" without breaking that already
 * -tested workflow. The only schema-valid move is at export: write NEITHER
 * the `IFCPROPERTYSET`/`IFCELEMENTQUANTITY` record NOR the
 * `IFCRELDEFINESBYPROPERTIES` that would bind an entity to it.
 */

import { describe, expect, it } from 'vitest';
import { IfcParser, extractPropertiesOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from './step-exporter.js';

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

const WALL_ID = 8;

const BASE_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition[DesignTransferView]'),'2;1');
FILE_NAME('base.ifc','2026-08-08T10:00:00+01:00',(''),(''),'ifc-lite','ifc-lite','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0OSuGGYUFyIf0LtE29OSuG',$,'My Project',$,$,$,$,$,$);
#8=IFCWALL('0OSuGGYUFyIf0LtE29OSuH',$,'Existing Wall',$,$,$,$,$,$);
#50=IFCPROPERTYSET('0OSuGGYUFyIf0LtE29OSuQ',$,'Pset_WallCommon',$,(#51));
#51=IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.T.),$);
#52=IFCRELDEFINESBYPROPERTIES('0OSuGGYUFyIf0LtE29OSuR',$,$,$,(#8),#50);
ENDSEC;
END-ISO-10303-21;`;

async function parseBase(): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(toArrayBuffer(new TextEncoder().encode(BASE_IFC)));
}

function newSession(store: IfcDataStore) {
  const view = new MutablePropertyView(null, 'test-model');
  view.setOnDemandExtractor((id: number) => extractPropertiesOnDemand(store, id));
  return { view, editor: new StoreEditor(store, view) };
}

describe('an empty property/quantity set is never written into a SET [1:?] slot (#5199)', () => {
  it('an empty property set omits both IFCPROPERTYSET and its IFCRELDEFINESBYPROPERTIES', async () => {
    const store = await parseBase();
    const { editor, view } = newSession(store);
    editor.addPropertySet(WALL_ID, 'Pset_Empty', []);

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const text = new TextDecoder().decode(result.content);

    // The schema-invalid shape the issue reproduced must never appear.
    expect(text).not.toMatch(/IFCPROPERTYSET\([^;]*,\(\)\)/);
    // Nor must the empty set be represented as `$` in that slot — the
    // attribute is not OPTIONAL, so that is a different invalid file.
    expect(text).not.toMatch(/IFCPROPERTYSET\('[^']*',[^,]*,'Pset_Empty',\$,\$\)/);
    // The set itself must not exist at all.
    expect(text).not.toContain('Pset_Empty');
    // Proves the branch actually ran (not just "no crash"): the pre-fix
    // exporter emits a REL binding the wall to the (invalid) empty set. An
    // orphaned REL pointing at a set that was never emitted would be worse
    // than the original bug, so pin its absence explicitly, keyed off the
    // fact that #52 is the ONLY IFCRELDEFINESBYPROPERTIES in the output.
    const relCount = (text.match(/IFCRELDEFINESBYPROPERTIES\(/g) ?? []).length;
    expect(relCount).toBe(1);
    expect(text).toContain("IFCRELDEFINESBYPROPERTIES('0OSuGGYUFyIf0LtE29OSuR'");
  });

  it('an empty quantity set omits both IFCELEMENTQUANTITY and its IFCRELDEFINESBYPROPERTIES', async () => {
    const store = await parseBase();
    const { editor, view } = newSession(store);
    editor.addQuantitySet(WALL_ID, 'Qto_Empty', []);

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const text = new TextDecoder().decode(result.content);

    expect(text).not.toMatch(/IFCELEMENTQUANTITY\([^;]*,\(\)\)/);
    expect(text).not.toMatch(/IFCELEMENTQUANTITY\('[^']*',[^,]*,'Qto_Empty',\$,\$,\$\)/);
    expect(text).not.toContain('Qto_Empty');
    const relCount = (text.match(/IFCRELDEFINESBYPROPERTIES\(/g) ?? []).length;
    expect(relCount).toBe(1);
    expect(text).toContain("IFCRELDEFINESBYPROPERTIES('0OSuGGYUFyIf0LtE29OSuR'");
  });

  it('non-regression: a NORMAL non-empty pset and qset still export unchanged', async () => {
    const store = await parseBase();
    const { editor, view } = newSession(store);
    editor.addPropertySet(WALL_ID, 'Pset_New', [{ name: 'Foo', value: 'bar', type: 'TEXT' }]);
    editor.addQuantitySet(WALL_ID, 'Qto_New', [{ name: 'NetVolume', value: 1.5, quantityType: 'VOLUME' }]);

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const text = new TextDecoder().decode(result.content);

    expect(text).toContain('Pset_New');
    expect(text).toMatch(/IFCPROPERTYSET\('[^']*',\$,'Pset_New',\$,\(#\d+\)\)/);
    expect(text).toContain('Qto_New');
    expect(text).toMatch(/IFCELEMENTQUANTITY\('[^']*',\$,'Qto_New',\$,\$,\(#\d+\)\)/);
    // Both new sets get their own REL, alongside the base file's one.
    const relCount = (text.match(/IFCRELDEFINESBYPROPERTIES\(/g) ?? []).length;
    expect(relCount).toBe(3);
  });
});
