/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * github.com/LTplus-AG/ifc-lite/issues/2488: `PropertyValueType.Enum` was
 * written into `IfcPropertySingleValue.NominalValue` as a BARE EXPRESS
 * enumeration token (`.EXTERNAL.`).
 *
 * That slot is declared `IfcValue`, and `IfcValue` is
 * `IfcMeasureValue | IfcSimpleValue | IfcDerivedMeasureValue` in every schema
 * this exporter targets (IFC2X3, IFC4, IFC4X3). None of those three has an
 * ENUMERATION leaf, so no wrapper exists for an enumeration token and a bare
 * one is not a member of the SELECT at all — it is the only branch of
 * `serializePropertyValue` that wrote an unqualified token, while every other
 * one writes `IFCLABEL('…')` / `IFCBOOLEAN(.T.)` / `IFCLOGICAL(.U.)` for
 * exactly that reason.
 *
 * ## Blast radius, which is what settled the fix
 *
 * NO extraction path produces `Enum`: the property extractor collapses every
 * string-valued token to `PropertyValueType.String`, and a source
 * `IfcPropertyEnumeratedValue` is a different property CLASS rather than a
 * `NominalValue` token. `StoreEditor.PropertyKind` cannot express it either.
 * The only way to reach this branch is `MutablePropertyView.setProperty(…,
 * PropertyValueType.Enum)` with the type named explicitly, so the change is
 * confined to properties AUTHORED that way in a session — there is no source
 * file whose re-export moves.
 *
 * That is also why the `.toUpperCase()` goes with it. It existed to make an
 * EXPRESS enumeration token, which is upper-case by construction; a label is
 * not, and folding case on the way out meant an authored `'external'` came
 * back as `'EXTERNAL'` and the round trip lost the value the caller wrote.
 */

import { describe, expect, it } from 'vitest';
import { PropertyValueType } from '@ifc-lite/data';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { serializePropertyValue } from './step-serialization.js';
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
ENDSEC;
END-ISO-10303-21;`;

async function parseBase(): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(toArrayBuffer(new TextEncoder().encode(BASE_IFC)));
}

describe('an Enum property value is qualified like every other IfcValue member', () => {
  it('writes IFCLABEL, not a bare enumeration token', () => {
    expect(serializePropertyValue('external', PropertyValueType.Enum)).toBe("IFCLABEL('external')");
  });

  it('keeps the authored casing, so the value round-trips', () => {
    // The extractor reads `IFCLABEL('External')` back as the String 'External'.
    // Upper-casing on the way out made that impossible to recover.
    expect(serializePropertyValue('External', PropertyValueType.Enum)).toBe("IFCLABEL('External')");
    expect(serializePropertyValue('EXTERNAL', PropertyValueType.Enum)).toBe("IFCLABEL('EXTERNAL')");
  });

  it('escapes the value like any other string, so a quote cannot break the record', () => {
    // A bare token was never escaped, because an EXPRESS enumeration name
    // cannot contain a quote. A label can.
    expect(serializePropertyValue("it's", PropertyValueType.Enum)).toBe("IFCLABEL('it''s')");
  });

  it('a null Enum is still an omitted attribute', () => {
    expect(serializePropertyValue(null, PropertyValueType.Enum)).toBe('$');
  });

  it('the exported FILE carries the wrapped value', async () => {
    const store = await parseBase();
    const view = new MutablePropertyView(null, 'test-model');
    view.setProperty(WALL_ID, 'Pset_Authored', 'Status', 'external', PropertyValueType.Enum);

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const text = new TextDecoder().decode(result.content);

    expect(text).toContain("IFCPROPERTYSINGLEVALUE('Status',$,IFCLABEL('external'),$)");
    // The shape #2488 reported, gone: nothing in the file puts a bare
    // enumeration token in a NominalValue slot.
    expect(text).not.toContain(".EXTERNAL.");
  });

  it('a List of enum-ish strings is unchanged - its members were already labels', () => {
    // The bounding control for the branch next door: `List` serializes its
    // members as `String`, so it never reached the Enum branch and must not
    // move now.
    expect(serializePropertyValue(['a', 'b'], PropertyValueType.List))
      .toBe("(IFCLABEL('a'),IFCLABEL('b'))");
  });
});
