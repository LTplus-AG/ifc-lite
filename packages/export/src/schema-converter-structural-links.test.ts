/* SPDX-License-Identifier: MPL-2.0 */
import { describe, expect, it } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { StepExporter, exportToStep } from './step-exporter.js';

const model = (schema: string, data: string): string =>
  `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('ViewDefinition [StructuralAnalysisView]'),'2;1');\nFILE_NAME('t.ifc','',(''),(''),'','','');\nFILE_SCHEMA(('${schema}'));\nENDSEC;\nDATA;\n${data}\nENDSEC;\nEND-ISO-10303-21;\n`;
const parse = (text: string): Promise<IfcDataStore> => new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer as ArrayBuffer);
const lines = (step: string, pattern: RegExp): string[] => step.split('\n').filter((l) => pattern.test(l));

const IFC2X3 = model('IFC2X3', `#1=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'P',$,$,$,$,$,$);
#10=IFCBEAM('2O2Fr$t4X7Zf8NOew3FLOH',$,'Beam',$,$,$,$,$);
#20=IFCSTRUCTURALCURVEMEMBER('1kTvXnbbzCWw8lcMd1dR4o',$,'Member',$,$,$,$,.RIGID_JOINED_MEMBER.);
#30=IFCRELCONNECTSSTRUCTURALELEMENT('3KIbrf6nfOzPbzsemNGvi0',$,$,$,#10,#20);`);

// #9668: IFC4 writes IfcRelConnectsStructuralElement as IfcRelAssignsToProduct;
// IFC2X3 gets its own entity back on the way down.
describe('physical-to-analytical link IFC4 -> IFC2X3 #9668', () => {
  it('round trips IfcRelConnectsStructuralElement through IFC4', async () => {
    const ifc4 = exportToStep(await parse(IFC2X3), { schema: 'IFC4' });
    expect(lines(ifc4, /^#30=/)).toEqual(["#30=IFCRELASSIGNSTOPRODUCT('3KIbrf6nfOzPbzsemNGvi0',$,$,$,(#20),$,#10);"]);
    const result = new StepExporter(await parse(ifc4)).export({ schema: 'IFC2X3' });
    const back = new TextDecoder().decode(result.content);
    expect(lines(back, /^#30=/)).toEqual(["#30=IFCRELCONNECTSSTRUCTURALELEMENT('3KIbrf6nfOzPbzsemNGvi0',$,$,$,#10,#20);"]);
    expect(result.stats.warnings.join('\n')).toContain('1 structural conversion record(s): IfcRelAssignsToProduct linking one structural member to its element is written as IfcRelConnectsStructuralElement');
  });

  it('keeps every other IfcRelAssignsToProduct as it is', async () => {
    const ifc4 = model('IFC4', `#1=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'P',$,$,$,$,$,$);
#10=IFCBEAM('2O2Fr$t4X7Zf8NOew3FLOH',$,'Beam',$,$,$,$,$,$);
#11=IFCBEAM('0xW3zI5Kj4Ch4Yx2s8P4ma',$,'Beam 2',$,$,$,$,$,$);
#20=IFCSTRUCTURALCURVEMEMBER('1kTvXnbbzCWw8lcMd1dR4o',$,'Member',$,$,$,$,.RIGID_JOINED_MEMBER.,$);
#21=IFCSTRUCTURALCURVEMEMBER('2kTvXnbbzCWw8lcMd1dR4o',$,'Member 2',$,$,$,$,.RIGID_JOINED_MEMBER.,$);
#31=IFCRELASSIGNSTOPRODUCT('1aaaaaaaaaaaaaaaaaaaaa',$,$,$,(#20,#21),$,#10);
#32=IFCRELASSIGNSTOPRODUCT('1bbbbbbbbbbbbbbbbbbbbb',$,$,$,(#20),.PRODUCT.,#10);
#33=IFCRELASSIGNSTOPRODUCT('1ccccccccccccccccccccc',$,$,$,(#11),$,#10);
#34=IFCRELASSIGNSTOPRODUCT('1ddddddddddddddddddddd',$,$,$,(#20),$,#21);`);
    const out = exportToStep(await parse(ifc4), { schema: 'IFC2X3' });
    expect(lines(out, /IFCRELCONNECTSSTRUCTURALELEMENT/)).toEqual([]);
    expect(lines(out, /^#3\d=IFCRELASSIGNSTOPRODUCT\(/)).toHaveLength(4);
  });

  it('needs the source types, so a subset export leaves the link as an assignment', async () => {
    const store = await parse(exportToStep(await parse(IFC2X3), { schema: 'IFC4' }));
    const out = exportToStep(store, { schema: 'IFC2X3', subsetEntityIds: new Set([1, 10, 20, 30]) });
    expect(lines(out, /^#30=/)).toEqual([expect.stringMatching(/^#30=IFCRELASSIGNSTOPRODUCT\(/)]);
  });
});
