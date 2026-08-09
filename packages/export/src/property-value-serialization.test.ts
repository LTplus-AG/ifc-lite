/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * github.com/LTplus-AG/ifc-lite/issues/2472: the token `serializePropertyValue`
 * writes IS the property's declared type in the exported file, so the whole
 * mapping is asserted here rather than the one member the issue named.
 *
 * Two were wrong. `Text` was written as `IFCLABEL` — `IfcLabel` is a bounded,
 * name-like string and `IfcText` is unbounded prose, so a consumer read a
 * different type than the property was authored with and a long value exceeded
 * what `IfcLabel` is specified to carry. `Logical` was written as `IFCBOOLEAN`
 * for its two definite states, borrowing the name of the two-valued primitive
 * for the three-valued one.
 *
 * ## Why nothing caught either
 *
 * A value-level round-trip is BLIND to the wrapper: the property extractor
 * collapses every string-valued token (`IFCLABEL`, `IFCTEXT`, `IFCIDENTIFIER`)
 * to `PropertyValueType.String` and keeps the token name only in `dataType`, so
 * a value exported through the wrong wrapper comes back byte-identical in the
 * VALUE and simply loses its declared type on the way. The last case in this
 * file pins that blindness in place, so the next reader does not mistake a
 * passing round-trip for cover.
 *
 * `@ifc-lite/collab`'s `PROPERTY_TYPE_NAMES` is the same table for a different
 * transport, and it already named both correctly — the sibling copy was right
 * while this one was not.
 */

import { describe, expect, it } from 'vitest';
import { PropertyValueType } from '@ifc-lite/data';
import { IfcParser, extractPropertiesOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { serializePropertyValue } from './step-serialization.js';
import { StepExporter } from './step-exporter.js';

describe('every PropertyValueType maps to the IFC primitive it was authored as', () => {
  /** The whole table, in enum order. A member missing from this list is a
   *  member nothing pins. */
  const CASES: Array<[label: string, type: PropertyValueType, value: unknown, expected: string]> = [
    // The extractor's catch-all for a string whose declared type it did not
    // keep: the bounded primitive is the conservative default.
    ['String', PropertyValueType.String, 'abc', "IFCLABEL('abc')"],
    ['Real', PropertyValueType.Real, 1.5, 'IFCREAL(1.5)'],
    ['Integer', PropertyValueType.Integer, 3, 'IFCINTEGER(3)'],
    ['Boolean true', PropertyValueType.Boolean, true, 'IFCBOOLEAN(.T.)'],
    ['Boolean false', PropertyValueType.Boolean, false, 'IFCBOOLEAN(.F.)'],
    ['Logical true', PropertyValueType.Logical, true, 'IFCLOGICAL(.T.)'],
    ['Logical false', PropertyValueType.Logical, false, 'IFCLOGICAL(.F.)'],
    ['Label', PropertyValueType.Label, 'WT1', "IFCLABEL('WT1')"],
    ['Identifier', PropertyValueType.Identifier, 'A-01', "IFCIDENTIFIER('A-01')"],
    ['Text', PropertyValueType.Text, 'a long prose value', "IFCTEXT('a long prose value')"],
    ['Enum', PropertyValueType.Enum, 'external', '.EXTERNAL.'],
    ['List', PropertyValueType.List, ['a', 'b'], "(IFCLABEL('a'),IFCLABEL('b'))"],
  ];

  for (const [label, type, value, expected] of CASES) {
    it(`${label} → ${expected}`, () => {
      expect(serializePropertyValue(value, type)).toBe(expected);
    });
  }

  it('a null value is an omitted attribute for every type but Logical', () => {
    expect(serializePropertyValue(null, PropertyValueType.Text)).toBe('$');
    expect(serializePropertyValue(undefined, PropertyValueType.Real)).toBe('$');
    expect(serializePropertyValue(null, PropertyValueType.Boolean)).toBe('$');
  });

  it('a null Logical is the third STATE, not a missing value', () => {
    // The extractor reads `.U.` / `.X.` back as a null-valued Logical — that
    // null IS the unknown state, and `$` on re-export would throw away the very
    // thing that makes the property Logical rather than Boolean.
    expect(serializePropertyValue(null, PropertyValueType.Logical)).toBe('IFCLOGICAL(.U.)');
  });

  it('a Boolean that is neither true nor false falls back to the three-state primitive', () => {
    // Unchanged from before #2472, and deliberately: no IfcBoolean literal says
    // "unknown", so there is nothing narrower to fall back to.
    expect(serializePropertyValue('maybe', PropertyValueType.Boolean)).toBe('IFCLOGICAL(.U.)');
  });

  it('Reference falls through to a label, which is what it can express here', () => {
    // No extraction path produces `Reference` (an IfcPropertyReferenceValue
    // comes back as a String holding `#id`), and this function could not
    // express one if it did: an entity reference is a different property CLASS,
    // not a different NominalValue token. Pinned as a documented fallback so a
    // future reader does not read the missing case as an oversight.
    expect(serializePropertyValue('#42', PropertyValueType.Reference)).toBe("IFCLABEL('#42')");
  });
});

const BASE_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition[DesignTransferView]'),'2;1');
FILE_NAME('base.ifc','2026-08-08T10:00:00+01:00',(''),(''),'ifc-lite','ifc-lite','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0OSuGGYUFyIf0LtE29OSuG',$,'My Project',$,$,$,$,$,$);
#8=IFCWALL('0OSuGGYUFyIf0LtE29OSuH',$,'Existing Wall',$,$,$,$,$,$);
#50=IFCPROPERTYSET('0OSuGGYUFyIf0LtE29OSuQ',$,'Pset_Prose',$,(#51));
#51=IFCPROPERTYSINGLEVALUE('Notes',$,IFCTEXT('a long prose value'),$);
#52=IFCRELDEFINESBYPROPERTIES('0OSuGGYUFyIf0LtE29OSuR',$,$,$,(#8),#50);
ENDSEC;
END-ISO-10303-21;`;

const WALL_ID = 8;

async function parseBase(): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(BASE_IFC);
  return new IfcParser().parseColumnar(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
}

describe('the exported file carries the authored primitive', () => {
  it('a property authored as Text is written as IFCTEXT', async () => {
    const store = await parseBase();
    const view = new MutablePropertyView(null, 'test-model');
    const editor = new StoreEditor(store, view);
    // `StoreEditor`'s TEXT kind is `PropertyValueType.Text` — the whole path
    // from the authoring API to the file, not the pure function alone.
    editor.addPropertySet(WALL_ID, 'Pset_Authored', [
      { name: 'Notes', value: 'a long prose value', type: 'TEXT' },
    ]);

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const text = new TextDecoder().decode(result.content);

    expect(text).toContain("IFCPROPERTYSINGLEVALUE('Notes',$,IFCTEXT('a long prose value'),$)");
    expect(text).not.toContain("IFCLABEL('a long prose value')");
  });

  it('a property authored as Label is still written as IFCLABEL', async () => {
    // The bounding control: the fix must not turn every string into prose.
    const store = await parseBase();
    const view = new MutablePropertyView(null, 'test-model');
    const editor = new StoreEditor(store, view);
    editor.addPropertySet(WALL_ID, 'Pset_Authored', [
      { name: 'Mark', value: 'W-01', type: 'LABEL' },
    ]);

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const text = new TextDecoder().decode(result.content);

    expect(text).toContain("IFCPROPERTYSINGLEVALUE('Mark',$,IFCLABEL('W-01'),$)");
  });

  it('re-exporting a SOURCE IfcText property keeps its value — and that is why nothing caught #2472', async () => {
    const store = await parseBase();
    // A view wired to the store, so the base pset's OTHER property really is
    // read back and regenerated rather than silently absent.
    const view = new MutablePropertyView(null, 'test-model');
    view.setOnDemandExtractor((id: number) => extractPropertiesOnDemand(store, id));
    // Adding a property to the EXISTING pset (rather than re-adding the pset,
    // which replaces it wholesale) regenerates every property in it from the
    // extracted model — `Notes` included.
    view.setProperty(WALL_ID, 'Pset_Prose', 'Mark', 'W-01', PropertyValueType.Label);

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const text = new TextDecoder().decode(result.content);

    // The VALUE survives, which is all a round-trip assertion would have seen.
    expect(text).toContain("'a long prose value'");
    // The DECLARED TYPE does not: the extractor reported `Notes` as a String
    // (its `IFCTEXT` token survives only in `dataType`, which the generator
    // does not read), so a regenerated source property is re-declared as the
    // catch-all primitive. That is a wider change than #2472 — it would mean
    // honouring `dataType` for every regenerated property, IFCLENGTHMEASURE
    // included — and is tracked as
    // github.com/LTplus-AG/ifc-lite/issues/2482. Asserted here ON PURPOSE, as
    // the reason a round-trip test is not cover for the mapping table: when
    // #2482 lands this line fails, which is exactly when it should be rewritten
    // to `IFCTEXT`.
    expect(text).toContain("IFCPROPERTYSINGLEVALUE('Notes',$,IFCLABEL('a long prose value'),$)");
  });
});
