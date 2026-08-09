/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * github.com/LTplus-AG/ifc-lite/issues/2470, first half: the OTHER two places
 * that rewrite a type object's slot 5, audited against the shape #2469 fixed.
 *
 * That failure needed three things at once: a helper that can fail, a caller
 * that reads the failure as "nothing to do", and an earlier pass that had
 * already stepped aside expecting this one to emit the line. Neither remaining
 * site has all three, and the first of them is missing entirely — neither calls
 * `replaceStepArgument` at all:
 *
 *   - `retype.ts` (`retypeStepLine`) parses the line itself and returns its
 *     INPUT unchanged when it cannot, so there is no null to misread. It also
 *     runs inside the source-iteration pass, whose result is pushed
 *     unconditionally.
 *   - the overlay new-entities pass writes slot 5 as a positional override on
 *     the AUTHORED payload (`applyOverlayEntityOverrides`), which pads the
 *     record to the class's declared arity before assigning. A short payload
 *     therefore GROWS to reach the slot rather than falling off the end, and
 *     the line is pushed whether or not the override landed.
 *
 * That is the argument. These are the tests, run on the same truncated input
 * that produced the original drop — for the source caller a truncated line, for
 * the overlay caller its equivalent, an authored payload shorter than the slot.
 */

import { describe, expect, it } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { retypeStepLine } from './retype.js';
import { StepExporter } from './step-exporter.js';

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Every `#id=CLASS(...)` defining line in the DATA section. */
function dataEntityLines(stepText: string): string[] {
  const start = stepText.indexOf('DATA;') + 'DATA;'.length;
  const data = stepText.slice(start, stepText.indexOf('ENDSEC;', start));
  return data.split('\n').map((l) => l.trim()).filter((l) => /^#\d+\s*=/.test(l));
}

/** The single defining line for `expressId`, or null. */
function lineFor(stepText: string, expressId: number): string | null {
  const m = new RegExp(`^#${expressId}\\s*=.*$`, 'm').exec(stepText);
  return m ? m[0] : null;
}

const TYPE_ID = 5;

/** `#5` truncated after `Name`: three arguments where `IfcWallType` declares
 *  ten, so nothing can reach slot 5 by index. #2469's reproduction verbatim. */
const TRUNCATED_TYPE_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition[DesignTransferView]'),'2;1');
FILE_NAME('truncated.ifc','2026-08-08T10:00:00+01:00',(''),(''),'ifc-lite','ifc-lite','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0OSuGGYUFyIf0LtE29OSuG',$,'My Project',$,$,$,$,$,$);
#5=IFCWALLTYPE('0OSuGGYUFyIf0LtE29OSuT',$,'WT1');
#9=IFCWALL('0OSuGGYUFyIf0LtE29OSuW',$,'W1',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;`;

async function parse(text: string): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(toArrayBuffer(new TextEncoder().encode(text)));
}

function newSession(store: IfcDataStore) {
  const view = new MutablePropertyView(null, 'test-model');
  return { view, editor: new StoreEditor(store, view) };
}

describe('caller 1: the retype path has no null to misread', () => {
  it('returns the line it was given when it cannot parse it', () => {
    // Not `null`, and not the empty string — the two values a caller could
    // mistake for "there is nothing to write".
    expect(retypeStepLine('not a step record', 'IfcWall', 'IfcColumn', null, 'IFC4'))
      .toBe('not a step record');
    expect(retypeStepLine('#5=IFCWALLTYPE', 'IfcWallType', 'IfcColumnType', null, 'IFC4'))
      .toBe('#5=IFCWALLTYPE');
  });

  it('retypes a TRUNCATED line and keeps the entity in the file', async () => {
    const store = await parse(TRUNCATED_TYPE_IFC);
    const { view } = newSession(store);
    view.setEntityType(TYPE_ID, 'IfcColumnType');

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const text = new TextDecoder().decode(result.content);

    // The input that dropped the entity through the repoint caller goes through
    // this one intact: three source lines in, three out.
    expect(dataEntityLines(text)).toHaveLength(3);
    expect(lineFor(text, TYPE_ID)).toContain('IFCCOLUMNTYPE');
    // ...and the short argument list was re-laid-out to the target class's full
    // arity rather than left truncated, so nothing downstream reads a slot that
    // is not there.
    expect(lineFor(text, TYPE_ID)).toMatch(/^#5=IFCCOLUMNTYPE\((?:[^,]*,){9}[^,]*\);$/);
  });

  it('a retype AND a repoint on the same truncated line emit exactly one line', async () => {
    const store = await parse(TRUNCATED_TYPE_IFC);
    const { view, editor } = newSession(store);
    // Both slot-5 writers on one entity, on the input that dropped it before.
    view.setEntityType(TYPE_ID, 'IfcColumnType');
    editor.addPropertySet(TYPE_ID, 'Pset_New', [{ name: 'Foo', value: 'bar', type: 'TEXT' }]);

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const text = new TextDecoder().decode(result.content);

    const lines = dataEntityLines(text).filter((l) => l.startsWith(`#${TYPE_ID}=`));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('IFCCOLUMNTYPE');
    // ...and the repoint SUCCEEDS here, which is worth stating: the retype runs
    // first inside the shared pipeline and re-lays the three surviving tokens
    // out against the target class, so `replaceStepArgument` is handed a
    // full-arity record and finds a slot 5 the SOURCE line did not have. The
    // fallback warning is for the case where nothing padded it (see
    // `type-object-rewrite-fallback.test.ts`, same file with no retype).
    expect(result.stats.warnings).toEqual([]);
    const generatedPsetId = /#(\d+)=IFCPROPERTYSET\([^;]*'Pset_New'/.exec(text)?.[1];
    expect(generatedPsetId).toBeDefined();
    expect(lines[0].split(',')[5]).toBe(`(#${generatedPsetId})`);
  });
});

describe('caller 2: the overlay new-entities path grows the record to reach slot 5', () => {
  it('writes HasPropertySets on a created type whose payload is too short to have it', async () => {
    const store = await parse(TRUNCATED_TYPE_IFC);
    const { view, editor } = newSession(store);

    // The overlay equivalent of a truncated line: an authored payload with
    // three attributes, where HasPropertySets is the sixth. Nothing rejects it —
    // `addEntity` takes the payload as given.
    const created = editor.addEntity('IfcWallType', ['0OSuGGYUFyIf0LtE29OSuX', null, 'WT2']);
    editor.addPropertySet(created.expressId, 'Pset_Created', [
      { name: 'Foo', value: 'bar', type: 'TEXT' },
    ]);

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const text = new TextDecoder().decode(result.content);
    const line = lineFor(text, created.expressId);

    // The line exists, which is the drop this audit is about...
    expect(line).not.toBeNull();
    // ...it was padded out to the declared arity rather than left at three...
    expect(line).toMatch(/^#\d+=IFCWALLTYPE\((?:[^,]*,){9}[^,]*\);$/);
    // ...and slot 5 names the generated pset, so it is not an orphan. Slot 5 is
    // the sixth comma-separated argument.
    const generatedPsetId = /#(\d+)=IFCPROPERTYSET\([^;]*'Pset_Created'/.exec(text)?.[1];
    expect(generatedPsetId).toBeDefined();
    expect(line!.split(',')[5]).toBe(`(#${generatedPsetId})`);
    // A type object owns its psets through that slot, never through a relation.
    expect(text).not.toMatch(
      new RegExp(`IFCRELDEFINESBYPROPERTIES\\([^;]*\\(#${created.expressId}\\)`),
    );
  });

  it('a created type with an unknown class keeps its authored payload and its psets', async () => {
    const store = await parse(TRUNCATED_TYPE_IFC);
    const { view, editor } = newSession(store);

    // A class no bundled schema declares has no inheritance chain, so
    // `isTypeClass` calls it an occurrence and its pset goes out on a relation —
    // the deliberately safe direction, and the reason slot 5 can never be
    // written into a record whose arity is unknown. The entity still comes out.
    const created = editor.addEntity('IfcVendorSpecialType', ['0OSuGGYUFyIf0LtE29OSuY', null, 'V1']);
    editor.addPropertySet(created.expressId, 'Pset_Created', [
      { name: 'Foo', value: 'bar', type: 'TEXT' },
    ]);

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const text = new TextDecoder().decode(result.content);

    expect(lineFor(text, created.expressId)).toContain('IFCVENDORSPECIALTYPE');
    expect(text).toMatch(
      new RegExp(`IFCRELDEFINESBYPROPERTIES\\([^;]*\\(#${created.expressId}\\)`),
    );
  });
});
