/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { convertStepLine } from './schema-converter.js';
import { StepExporter } from './step-exporter.js';

// #5202 finding 2: cardinality tightening on a downgrade to IFC4 was
// entirely unguarded (only `toSchema === 'IFC2X3'` had a fill/count
// mechanism). `IfcProjectedCRS.Name` is optional in IFC4X3 and mandatory in
// IFC4, at position 0 — a valid IFC4X3 record legitimately carries `$` there.

// Every test enters through a seam that exists without the fix
// (`convertStepLine`, `StepExporter`), so reverting the production change
// yields a failed assertion rather than a missing import.
describe('schema-converter: IFC4-target required slots (#5202)', () => {
  it('never writes a value into a required slot: labels, references and flags all stay $', () => {
    // IfcAdvancedFace.SameSense is a BOOLEAN IFC4 requires, but IFC4X3
    // requires it too, so `$` there is invalid source; `.F.` would flip the
    // face. The exporter counts these slots (below) instead.
    const face = '#20=IFCADVANCEDFACE($,$,$);';
    expect(convertStepLine(face, 'IFC4X3', 'IFC4')).toBe(face);
    const crs = "#10=IFCPROJECTEDCRS($,'A description',$,$,$,$,$);";
    expect(convertStepLine(crs, 'IFC4X3', 'IFC4')).toBe(crs);
  });

  it('IFC2X3-target conversions are unaffected: still exactly the pre-#5202 behaviour', () => {
    // No-regression pin: the IFC4 check never runs for a downgrade whose
    // target is IFC2X3; the two mechanisms are independent per `toSchema`.
    const line = "#40=IFCWALL('guid',$,'Wall 1',$,$,$,$,'tag',.STANDARD.);";
    const result = convertStepLine(line, 'IFC4', 'IFC2X3');
    expect(result).not.toContain('.STANDARD.');
    expect(result).toContain('IFCWALL(');
  });

  it('a same-schema conversion is still a no-op', () => {
    const line = "#50=IFCPROJECTEDCRS($,'A description',$,$,$,$,$);";
    expect(convertStepLine(line, 'IFC4', 'IFC4')).toBe(line);
  });
});

describe('StepExporter: an IFC4X3 model exported as IFC4 reports the unfillable slot (#5202)', () => {
  const IFC4X3_MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4X3_ADD2'));
ENDSEC;
DATA;
#1=IFCPROJECT('0OSuGGYUFyIf0LtE29OSuG',$,'P',$,$,$,$,$,$);
#10=IFCPROJECTEDCRS($,'A description',$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;`;
  const EXPECTED_WARNING = (n: number) =>
    `${n} slot(s) keep $ where IFC4 requires a value and the source offers none ` +
    '(the converter does not invent measures, labels, identifiers, references, flags or enums); ' +
    'the file is not valid IFC4 (#5202).';

  async function exportAs(schema: 'IFC4' | 'IFC4X3', model = IFC4X3_MODEL, edit?: (editor: StoreEditor) => void) {
    const bytes = new TextEncoder().encode(model);
    const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    const view = new MutablePropertyView(null, 'ifc4-slots');
    edit?.(new StoreEditor(store, view));
    const result = new StepExporter(store, view).export({ schema });
    return { text: new TextDecoder().decode(result.content), warnings: result.stats.warnings };
  }

  it('warns that IfcProjectedCRS.Name stays $ in the IFC4 file', async () => {
    const { text, warnings } = await exportAs('IFC4');
    expect(text).toContain("#10=IFCPROJECTEDCRS($,'A description',$,$,$,$,$);");
    expect(warnings).toContain(EXPECTED_WARNING(1));
  });

  it('counts a session-created record too, not only source lines', async () => {
    const { text, warnings } = await exportAs('IFC4', IFC4X3_MODEL, (editor) => {
      editor.addEntity('IfcProjectedCRS', [null, 'Created', null, null, null, null, null]);
    });
    expect(text.match(/IFCPROJECTEDCRS\(\$,/g)).toHaveLength(2);
    expect(warnings).toContain(EXPECTED_WARNING(2));
  });

  it('stays quiet when the IFC4-mandatory slot is already populated', async () => {
    const { warnings } = await exportAs('IFC4', IFC4X3_MODEL.replace("IFCPROJECTEDCRS($,", "IFCPROJECTEDCRS('EPSG:27700',"));
    expect(warnings.some((w) => w.includes('#5202'))).toBe(false);
  });

  it('stays quiet when no conversion to IFC4 runs', async () => {
    const { warnings } = await exportAs('IFC4X3');
    expect(warnings.some((w) => w.includes('#5202'))).toBe(false);
  });
});
