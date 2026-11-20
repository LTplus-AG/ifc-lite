/* SPDX-License-Identifier: MPL-2.0 */
/** #10846, as Rust `schema_document_links_tests.rs`: the document link moves to the other record. */
import { describe, expect, it } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { StepExporter, exportToStep } from './step-exporter.js';
import { analyzeConversionLoss } from './schema-conversion-loss-report.js';

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

  it('reports no loss of a link the export moves, and none for a repeat inside one list', async () => {
    const dropped = (store: IfcDataStore, from: 'IFC2X3' | 'IFC4', to: 'IFC2X3' | 'IFC4', type: string) =>
      analyzeConversionLoss(store, from, to).entries.find((e) => e.sourceType === type)?.droppedAttributes ?? [];
    const store = await parse(model('IFC2X3', IFC2X3));
    expect(dropped(store, 'IFC2X3', 'IFC4', 'IFCDOCUMENTINFORMATION')).not.toContain('DocumentReferences');
    const ifc4 = await parse(exportToStep(store, { schema: 'IFC4' }));
    expect(dropped(ifc4, 'IFC4', 'IFC2X3', 'IFCDOCUMENTREFERENCE')).not.toContain('ReferencedDocument');
    // Control: a reference no document lists keeps its loss.
    const unlisted = await parse(model('IFC2X3', IFC2X3.replace('(#6,#7)', '(#6,#9)')));
    expect(dropped(unlisted, 'IFC2X3', 'IFC4', 'IFCDOCUMENTINFORMATION')).toContain('DocumentReferences');
    const repeat = new StepExporter(await parse(model('IFC2X3', IFC2X3.replace('(#6,#7)', '(#6,#6,#7)')))).export({ schema: 'IFC4' });
    expect(record(new TextDecoder().decode(repeat.content), 6)).toBe("#6=IFCDOCUMENTREFERENCE('a.pdf','A1',$,$,#5);");
    expect(repeat.stats.warnings.join('\n')).not.toContain('IfcDocumentReference listing');
  });

  // /code-review on the #10872 restack: a repeated record id is its last copy, at that copy's place, as Rust's
  // `kept` reads it; a copy of another type is no holder.
  it('lists a reference once on a downgrade when its record id repeats', async () => {
    const ifc4 = `#1=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'P',$,$,$,$,$,$);
#5=IFCDOCUMENTINFORMATION('D1','Doc',$,$,$,$,$,$,$,$,$,$,$,$,$,$,$);
#6=IFCDOCUMENTREFERENCE('a.pdf','A1',$,$,#5);
#6=IFCDOCUMENTREFERENCE('a.pdf','A1',$,$,#5);
#7=IFCDOCUMENTREFERENCE('b.pdf','B1',$,$,#5);`;
    const down = new TextDecoder().decode(new StepExporter(await parse(model('IFC4', ifc4))).export({ schema: 'IFC2X3' }).content);
    expect(record(down, 5)).toBe("#5=IFCDOCUMENTINFORMATION('D1','Doc',$,(#6,#7),$,$,$,$,$,$,$,$,$,$,$,$,$);");
    // Not adjacent: the last copy's place orders the list.
    const apart = ifc4.replace("#6=IFCDOCUMENTREFERENCE('a.pdf','A1',$,$,#5);\n#7", "#7").replace("('b.pdf','B1',$,$,#5);", "('b.pdf','B1',$,$,#5);\n#6=IFCDOCUMENTREFERENCE('a.pdf','A1',$,$,#5);");
    const later = new TextDecoder().decode(new StepExporter(await parse(model('IFC4', apart))).export({ schema: 'IFC2X3' }).content);
    expect(record(later, 5)).toBe("#5=IFCDOCUMENTINFORMATION('D1','Doc',$,(#7,#6),$,$,$,$,$,$,$,$,$,$,$,$,$);");
    // Kept as another type of the same arity, with a reference in the link slot: no reference.
    const retyped = `${apart}\n#6=IFCDOCUMENTINFORMATIONRELATIONSHIP($,$,#5,(#5),#5);`;
    const walled = new TextDecoder().decode(new StepExporter(await parse(model('IFC4', retyped))).export({ schema: 'IFC2X3' }).content);
    expect(record(walled, 5)).toBe("#5=IFCDOCUMENTINFORMATION('D1','Doc',$,(#7),$,$,$,$,$,$,$,$,$,$,$,$,$);");
  });

  // Claude review on #10872: IFC4 WR1 is EXISTS(Name) XOR EXISTS(ReferencedDocument), so a named reference that
  // gains its document drops the Name (the document's stands); an unlisted one keeps it.
  it('drops the Name of a reference that gains ReferencedDocument, for IFC4 WR1', async () => {
    const named = `${IFC2X3.replace("('a.pdf','A1',$)", "('a.pdf','A1','Title')")}\n#8=IFCDOCUMENTREFERENCE('c.pdf','C1','Loose');`;
    for (const schema of ['IFC4', 'IFC4X3'] as const) {
      const result = new StepExporter(await parse(model('IFC2X3', named))).export({ schema });
      const up = new TextDecoder().decode(result.content);
      expect(record(up, 6), schema).toBe("#6=IFCDOCUMENTREFERENCE('a.pdf','A1',$,$,#5);");
      expect(record(up, 8), schema).toBe("#8=IFCDOCUMENTREFERENCE('c.pdf','C1','Loose',$,$);");
      expect(result.stats.warnings.join('\n'), schema).toContain('1 IfcDocumentReference Name(s) were dropped (the source breaks IFC2X3 WR1 too)');
    }
    const plain = new StepExporter(await parse(model('IFC2X3', IFC2X3))).export({ schema: 'IFC4' });
    expect(plain.stats.warnings.join('\n')).not.toContain('Name(s) were dropped');
    // The loss preview names it too.
    const loss = analyzeConversionLoss(await parse(model('IFC2X3', named)), 'IFC2X3', 'IFC4').entries.find((e) => e.sourceType === 'IFCDOCUMENTREFERENCE');
    expect(loss?.droppedAttributes).toEqual(['Name']);
    expect(loss?.expressIds).toEqual([6]);
    expect(analyzeConversionLoss(await parse(model('IFC2X3', IFC2X3)), 'IFC2X3', 'IFC4').entries.some((e) => e.sourceType === 'IFCDOCUMENTREFERENCE')).toBe(false);
  });

  // /code-review: IfcExternalReference.WR1 needs Location, Identification or Name, so a reference a Name alone
  // identifies keeps it and stays unlinked; the document's listing is then lost, as for an unlisted member.
  it('keeps the Name of a reference nothing else identifies, and leaves it unlinked', async () => {
    const nameOnly = IFC2X3.replace("('a.pdf','A1',$)", "($,$,'Title')");
    const result = new StepExporter(await parse(model('IFC2X3', nameOnly))).export({ schema: 'IFC4' });
    const up = new TextDecoder().decode(result.content);
    expect(record(up, 6)).toBe("#6=IFCDOCUMENTREFERENCE($,$,'Title',$,$);");
    expect(record(up, 7)).toBe("#7=IFCDOCUMENTREFERENCE('b.pdf','B1',$,$,#5);");
    const warnings = result.stats.warnings.join('\n');
    expect(warnings).toContain('1 IfcDocumentReference(s) identified only by Name keep it and lose');
    expect(warnings).not.toContain('Name(s) were dropped');
    const loss = analyzeConversionLoss(await parse(model('IFC2X3', nameOnly)), 'IFC2X3', 'IFC4').entries;
    expect(loss.find((e) => e.sourceType === 'IFCDOCUMENTINFORMATION')?.droppedAttributes).toContain('DocumentReferences');
    expect(loss.some((e) => e.sourceType === 'IFCDOCUMENTREFERENCE')).toBe(false);
  });

  it('arms nothing for a subset, which has no source links to read', async () => {
    const out = exportToStep(await parse(model('IFC2X3', IFC2X3)), { schema: 'IFC4', subsetEntityIds: new Set([5, 6, 7]) });
    expect(record(out, 6)).toBe("#6=IFCDOCUMENTREFERENCE('a.pdf','A1',$,$,$);");
  });
});
