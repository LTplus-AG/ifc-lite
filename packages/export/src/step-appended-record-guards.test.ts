/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #7682: the TypeScript half of the refusals the Rust mutation-log writer
 * makes (`rust/export/tests/step_writer_refusals.rs`).
 *
 * - EXPORT-STEP-26: a created entity's class is written as the record keyword
 *   verbatim, so a payload whose `type` is not an entity name would inject
 *   records the caller never created.
 * - EXPORT-STEP-26: a created entity under an id the source file already has
 *   means the log was written against another file; both writers refuse it.
 * - EXPORT-STEP-9: an express id past `u32::MAX` cannot be read back by any
 *   ifc-lite reader, so allocating one refuses the export.
 */

import { describe, expect, it } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { StepExporter } from './step-exporter.js';
import { allocatedExpressId } from './step-property-set-readers.js';

const BASE_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition[DesignTransferView]'),'2;1');
FILE_NAME('base.ifc','2026-03-05T16:26:36+01:00',(''),(''),'ifc-lite','ifc-lite','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('3hDMyWaBD34QvUUlT4RWFp',$,'My Project',$,$,$,$,$,$);
#2=IFCWALL('1wall0000000000000000a',$,'Existing Wall',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;`;

async function parse(text: string): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer as ArrayBuffer);
}

describe('appended-record guards (#7682)', () => {
  it('refuses a created entity whose class is not an entity name (EXPORT-STEP-26)', async () => {
    const store = await parse(BASE_IFC);
    const view = new MutablePropertyView(null, 'model');
    view.restoreNewEntity({ expressId: 10, type: "IfcWall($);\n#1=IFCFOO('x'", attributes: [] });
    expect(() => new StepExporter(store, view).export({ schema: 'IFC4' })).toThrow(/not a recognizable IFC entity name/);
  });

  it('writes a created entity whose class is an entity name', async () => {
    const store = await parse(BASE_IFC);
    const view = new MutablePropertyView(null, 'model');
    view.restoreNewEntity({ expressId: 10, type: 'IfcBuildingElementProxy', attributes: ['0proxy0000000000000000'] });
    const text = new TextDecoder().decode(new StepExporter(store, view).export({ schema: 'IFC4' }).content);
    expect(text).toMatch(/^#10=IFCBUILDINGELEMENTPROXY\('0proxy0000000000000000'/m);
  });

  it('refuses a created entity that reuses a source id (EXPORT-STEP-26)', async () => {
    const store = await parse(BASE_IFC);
    const view = new MutablePropertyView(null, 'model');
    view.restoreNewEntity({ expressId: 2, type: 'IfcWall', attributes: ['0proxy0000000000000000'] });
    expect(() => new StepExporter(store, view).export({ schema: 'IFC4' })).toThrow(
      'created entity #2 reuses source id #2',
    );
  });

  it('refuses an express id past u32::MAX (EXPORT-STEP-9)', () => {
    expect(allocatedExpressId(0xffffffff)).toBe(0xffffffff);
    expect(() => allocatedExpressId(0x100000000)).toThrow(RangeError);
  });
});
