/* SPDX-License-Identifier: MPL-2.0 */
/**
 * IFC2X3 lets an IfcRelSpaceBoundary leave RelatedBuildingElement `$`; IFC4 and
 * IFC4X3 make it mandatory (and CorrectPhysOrVirt wants an IfcVirtualElement or
 * IfcOpeningElement behind a VIRTUAL one). The converter invents no entity, so
 * an upgrade leaves such a boundary out and names it. Rust twin:
 * `schema_space_boundary_tests.rs`.
 */
import { describe, expect, it } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MergedExporter } from './merged-exporter.js';
import { StepExporter } from './step-exporter.js';
import { convertStepLine } from './schema-converter.js';
import { analyzeConversionLoss } from './schema-conversion-loss-report.js';

const model = (schema: string, data: string): string =>
  `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('t.ifc','',(''),(''),'','','');\nFILE_SCHEMA(('${schema}'));\nENDSEC;\nDATA;\n${data}\nENDSEC;\nEND-ISO-10303-21;\n`;
const parse = (text: string): Promise<IfcDataStore> => new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer as ArrayBuffer);

const VIRTUAL = "#20=IFCRELSPACEBOUNDARY('3XigBlHYfFnxzvgV9_gBmP',$,'1stLevel',$,#10,$,#12,.VIRTUAL.,.INTERNAL.);";
const PHYSICAL_UNBOUND = "#22=IFCRELSPACEBOUNDARY('2XigBlHYfFnxzvgV9_gBmP',$,'1stLevel',$,#10,$,$,.PHYSICAL.,.EXTERNAL.);";
const PHYSICAL = "#21=IFCRELSPACEBOUNDARY('1XigBlHYfFnxzvgV9_gBmP',$,'1stLevel',$,#10,#11,#12,.PHYSICAL.,.EXTERNAL.);";
const DATA = `#10=IFCSPACE('0YvctVUKr0kugbFTf53O9L',$,'S',$,$,$,$,$,.ELEMENT.,.INTERNAL.,$);
#11=IFCWALL('1YvctVUKr0kugbFTf53O9L',$,'W',$,$,$,$,$);
#12=IFCCONNECTIONSURFACEGEOMETRY(#13,$);
#13=IFCPLANE(#14);
#14=IFCAXIS2PLACEMENT3D(#15,$,$);
#15=IFCCARTESIANPOINT((0.,0.,0.));
${VIRTUAL}
${PHYSICAL}
${PHYSICAL_UNBOUND}`;

const out = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const ids = (text: string) => text.split('\n').filter((l) => l.includes('=IFCRELSPACEBOUNDARY(')).map((l) => l.slice(0, l.indexOf('=')));

describe('IFC2X3 upgrade of an IfcRelSpaceBoundary with no RelatedBuildingElement', () => {
  for (const to of ['IFC4', 'IFC4X3'] as const) {
    it(`convertStepLine omits it for ${to} and keeps one that names an element`, () => {
      expect(convertStepLine(VIRTUAL, 'IFC2X3', to)).toBeNull();
      expect(convertStepLine(PHYSICAL_UNBOUND, 'IFC2X3', to)).toBeNull();
      expect(convertStepLine(PHYSICAL, 'IFC2X3', to)).toBe(PHYSICAL);
    });
  }

  it('is an upgrade rule only: the same record is untouched in the other directions', () => {
    expect(convertStepLine(VIRTUAL, 'IFC4', 'IFC4X3')).toBe(VIRTUAL);
    expect(convertStepLine(VIRTUAL, 'IFC2X3', 'IFC2X3')).toBe(VIRTUAL);
    expect(convertStepLine(VIRTUAL, 'IFC4', 'IFC2X3')).not.toBeNull();
  });

  it('StepExporter writes the others, names what it left out, and the loss report agrees', async () => {
    const store = await parse(model('IFC2X3', DATA));
    const result = new StepExporter(store).export({ schema: 'IFC4' });
    expect(ids(out(result.content))).toEqual(['#21']);
    expect(result.stats.warnings.join('\n')).toContain('2 IfcRelSpaceBoundary record(s) were not written: IFC4 requires RelatedBuildingElement and the source names none: #20, #22.');
    const entry = analyzeConversionLoss(store, 'IFC2X3', 'IFC4').entries.find((e) => e.sourceType === 'IFCRELSPACEBOUNDARY');
    expect(entry).toMatchObject({ targetType: 'IFCRELSPACEBOUNDARY', kind: 'lossy', droppedAttributes: ['RelatedBuildingElement'], expressIds: [20, 22] });
    expect(analyzeConversionLoss(store, 'IFC2X3', 'IFC2X3').entries.find((e) => e.sourceType === 'IFCRELSPACEBOUNDARY')).toBeUndefined();
  });

  it('MergedExporter leaves it out too, in the merge id space, without throwing', async () => {
    const one = await parse(model('IFC2X3', DATA));
    const two = await parse(model('IFC2X3', DATA));
    const result = new MergedExporter([{ id: 'one', name: 'one', dataStore: one }, { id: 'two', name: 'two', dataStore: two }]).export({ schema: 'IFC4' });
    expect(ids(out(result.content))).toHaveLength(2);
    expect(result.stats.warnings.join('\n')).toContain('4 IfcRelSpaceBoundary record(s) were not written');
  });
});
