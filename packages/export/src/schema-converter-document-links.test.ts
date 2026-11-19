/* SPDX-License-Identifier: MPL-2.0 */
/** #10846, as Rust `schema_document_links_tests.rs`: the document link moves to the other record. */
import { describe, expect, it } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { StepExporter, exportToStep } from './step-exporter.js';

const model = (schema: string, data: string): string =>
  `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('t.ifc','',(''),(''),'','','');\nFILE_SCHEMA(('${schema}'));\nENDSEC;\nDATA;\n${data}\nENDSEC;\nEND-ISO-10303-21;\n`;
const parse = (text: string): Promise<IfcDataStore> => new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer as ArrayBuffer);
const record = (step: string, id: number): string | undefined => step.split('\n').find((l) => l.startsWith(`#${id}=`));

const IFC2X3 = `#1=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'P',$,$,$,$,$,$);
#5=IFCDOCUMENTINFORMATION('D1','Doc',$,(#6,#7),$,$,$,$,$,$,$,$,$,$,$,$,$);
#6=IFCDOCUMENTREFERENCE('a.pdf','A1',$);
#7=IFCDOCUMENTREFERENCE('b.pdf','B1',$);`;

describe('IfcDocumentInformation <-> IfcDocumentReference link (#10846)', () => {
  it('moves to each listed reference on an upgrade and back to the document on a downgrade', async () => {
    for (const schema of ['IFC4', 'IFC4X3'] as const) {
      const up = exportToStep(await parse(model('IFC2X3', IFC2X3)), { schema });
      expect(record(up, 5), schema).toBe("#5=IFCDOCUMENTINFORMATION('D1','Doc',$,$,$,$,$,$,$,$,$,$,$,$,$,$,$);");
      expect(record(up, 6), schema).toBe("#6=IFCDOCUMENTREFERENCE('a.pdf','A1',$,$,#5);");
      expect(record(up, 7), schema).toBe("#7=IFCDOCUMENTREFERENCE('b.pdf','B1',$,$,#5);");
      const back = exportToStep(await parse(up), { schema: 'IFC2X3' });
      expect(record(back, 5), schema).toBe("#5=IFCDOCUMENTINFORMATION('D1','Doc',$,(#6,#7),$,$,$,$,$,$,$,$,$,$,$,$,$);");
      expect(record(back, 6), schema).toBe("#6=IFCDOCUMENTREFERENCE('a.pdf','A1',$);");
    }
  });

  it('keeps the first document of a reference listed twice and reports the other listing', async () => {
    const source = `${IFC2X3}\n#8=IFCDOCUMENTINFORMATION('D2','Other',$,(#6),$,$,$,$,$,$,$,$,$,$,$,$,$);`;
    const result = new StepExporter(await parse(model('IFC2X3', source))).export({ schema: 'IFC4' });
    expect(record(new TextDecoder().decode(result.content), 6)).toBe("#6=IFCDOCUMENTREFERENCE('a.pdf','A1',$,$,#5);");
    expect(result.stats.warnings.join('\n')).toContain("1 IfcDocumentReference listing(s) past a reference's first IfcDocumentInformation");
  });

  it('arms nothing for a subset, which has no source links to read', async () => {
    const out = exportToStep(await parse(model('IFC2X3', IFC2X3)), { schema: 'IFC4', subsetEntityIds: new Set([5, 6, 7]) });
    expect(record(out, 6)).toBe("#6=IFCDOCUMENTREFERENCE('a.pdf','A1',$,$,$);");
  });
});
