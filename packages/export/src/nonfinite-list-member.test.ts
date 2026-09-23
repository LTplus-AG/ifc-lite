/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5217: a non-finite number reaching the serializer as a LIST MEMBER.
 *
 * `$` is ISO 10303-21's token for an omitted whole attribute. For an optional
 * REAL attribute fed `NaN` that is the right reading and it stays
 * (`real-slot-non-numeric.test.ts` pins `IfcMapConversion.Scale`). Inside a
 * list it has no reading at all: `IfcCartesianPoint((NaN,0,0))` used to ship
 * as `(($,0,0))`, a malformed `LIST [1:3] OF IfcLengthMeasure`. Every
 * in-store builder feeds `StoreEditor.addEntity`, and so do scripts, MCP and
 * flow nodes, so this is the backstop for all of them.
 */

import { describe, expect, it } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from './step-exporter.js';
import { serializeStepValue } from './step-serialization.js';

const BASE_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'');
FILE_NAME('t','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0OSuGGYUFyIf0LtE29OSuG',$,'My Project',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;`;

async function parseBase(): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(BASE_IFC);
  return new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
}

describe('serializeStepValue: non-finite numbers (#5217)', () => {
  it('refuses a non-finite list member instead of writing `$` into the list', () => {
    expect(() => serializeStepValue([Number.NaN, 0, 0])).toThrow(/not a legal list element/);
    expect(() => serializeStepValue([0, Number.POSITIVE_INFINITY])).toThrow(/Infinity/);
    expect(() => serializeStepValue([[0, 0], [Number.NaN, 1]])).toThrow(/list member/);
  });

  it('still writes a non-finite WHOLE attribute as `$` (the omitted-attribute reading)', () => {
    expect(serializeStepValue(Number.NaN)).toBe('$');
    expect(serializeStepValue(Number.POSITIVE_INFINITY, true)).toBe('$');
  });

  it('leaves finite lists unchanged', () => {
    expect(serializeStepValue([1.5, 0, -2])).toBe('(1.5,0,-2)');
    expect(serializeStepValue([1, 0, 0], true)).toBe('(1.,0.,0.)');
  });
});

describe('export of an overlay IfcCartesianPoint with a non-finite coordinate (#5217)', () => {
  it('fails naming the record instead of shipping (($,0,0))', async () => {
    const store = await parseBase();
    const view = new MutablePropertyView(null, 'nonfinite-point');
    new StoreEditor(store, view).addEntity('IfcCartesianPoint', [[Number.NaN, 0, 0]]);

    expect(() => new StepExporter(store, view).export({ schema: 'IFC4' })).toThrow(
      /IfcCartesianPoint attribute 0: Cannot write NaN as a STEP list member/,
    );
  });

  it('still exports a finite overlay IfcCartesianPoint', async () => {
    const store = await parseBase();
    const view = new MutablePropertyView(null, 'finite-point');
    new StoreEditor(store, view).addEntity('IfcCartesianPoint', [[1, 0, 0]]);

    const text = new TextDecoder().decode(new StepExporter(store, view).export({ schema: 'IFC4' }).content);
    expect(text).toMatch(/=IFCCARTESIANPOINT\(\(1\.,0\.,0\.\)\);/);
  });
});
