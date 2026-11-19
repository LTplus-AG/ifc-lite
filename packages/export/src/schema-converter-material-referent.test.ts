/* SPDX-License-Identifier: MPL-2.0 */
/** #10763, as Rust `schema_material_referent_tests.rs`: the IfcMaterial a downgraded IfcMaterialProperties names. */
import { describe, expect, it } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { MergedExporter, type MergeModelInput } from './merged-exporter.js';
import { StepExporter } from './step-exporter.js';
import { convertStepLine } from './schema-converter.js';
import { analyzeConversionLoss } from './schema-conversion-loss-report.js';
import { MaterialReferents } from './schema-converter-material-referent.js';

const model = (schema: string, data: string): string =>
  `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('t.ifc','',(''),(''),'','','');\nFILE_SCHEMA(('${schema}'));\nENDSEC;\nDATA;\n${data}\nENDSEC;\nEND-ISO-10303-21;\n`;
const parse = (text: string): Promise<IfcDataStore> => new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer as ArrayBuffer);
const BASE = `#1=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'P',$,$,$,$,$,$);
#8=IFCMATERIAL('Concrete',$,$);
#9=IFCMATERIAL('Steel',$,$);
#6=IFCPROPERTYSINGLEVALUE('p',$,IFCLABEL('v'),$);`;

/** The IFC2X3 output's #5 and the export warnings. */
async function down(from: string, data: string): Promise<{ line: string | undefined; warnings: string[] }> {
  const result = new StepExporter(await parse(model(from, `${BASE}\n${data}`))).export({ schema: 'IFC2X3' });
  const out = new TextDecoder().decode(result.content);
  return { line: out.split('\n').find((l) => l.startsWith('#5=')), warnings: result.stats.warnings };
}

const LAYERS = `#10=IFCMATERIALLAYER(#8,0.2,$,$,$,$,$);
#11=IFCMATERIALLAYER($,0.05,.T.,$,$,$,$);
#12=IFCMATERIALLAYER(#8,0.1,$,$,$,$,$);`;

describe('the Material a downgraded IfcMaterialProperties names (#10763)', () => {
  it('carries an IfcMaterial as it is', async () => {
    for (const from of ['IFC4', 'IFC4X3']) {
      expect((await down(from, "#5=IFCMATERIALPROPERTIES('Pset_x','d',(#6),#8);")).line, from)
        .toBe("#5=IFCEXTENDEDMATERIALPROPERTIES(#8,(#6),'d','Pset_x');");
    }
  });

  it('points a layer, or a set of one material, at that material', async () => {
    expect((await down('IFC4', `${LAYERS}\n#13=IFCMATERIALLAYERSET((#10,#11,#12),'Wall',$);\n#5=IFCMATERIALPROPERTIES('Pset_x',$,(#6),#13);`)).line)
      .toBe("#5=IFCEXTENDEDMATERIALPROPERTIES(#8,(#6),$,'Pset_x');");
    expect((await down('IFC4', `${LAYERS}\n#5=IFCMATERIALPROPERTIES('Pset_x',$,(#6),#10);`)).line)
      .toBe("#5=IFCEXTENDEDMATERIALPROPERTIES(#8,(#6),$,'Pset_x');");
  });

  it('leaves out a set of two materials and names it in the warnings and the loss report', async () => {
    const data = `#10=IFCMATERIALLAYER(#8,0.2,$,$,$,$,$);\n#12=IFCMATERIALLAYER(#9,0.1,$,$,$,$,$);\n#13=IFCMATERIALLAYERSET((#10,#12),'Wall',$);\n#5=IFCMATERIALPROPERTIES('Pset_x','d',(#6),#13);`;
    const { line, warnings } = await down('IFC4', data);
    expect(line).toBeUndefined();
    expect(warnings.join('\n')).toContain('1 IfcMaterialProperties record(s) were not written: IFC2X3 IfcExtendedMaterialProperties.Material must name one IfcMaterial, and theirs does not: #5 (IFCMATERIALLAYERSET) (#10763).');
    const store = await parse(model('IFC4', `${BASE}\n${data}`));
    const entry = (report: ReturnType<typeof analyzeConversionLoss>) => report.entries.find((e) => e.sourceType === 'IFCMATERIALPROPERTIES');
    expect(entry(analyzeConversionLoss(store, 'IFC4', 'IFC2X3'))).toMatchObject({
      targetType: 'IFCEXTENDEDMATERIALPROPERTIES', kind: 'lossy', droppedAttributes: ['Name', 'Description', 'Properties', 'Material'], expressIds: [5],
    });
    // Without the source bytes the export leaves it out too (nothing can check it), and the report says so.
    expect(entry(analyzeConversionLoss({ entityIndex: store.entityIndex }, 'IFC4', 'IFC2X3'))?.expressIds).toEqual([5]);
    expect(entry(analyzeConversionLoss({ entityIndex: store.entityIndex, source: new Uint8Array(0) }, 'IFC4', 'IFC2X3'))?.expressIds, 'sourceless store').toEqual([5]);
  });

  it('resolves a constituent set in the loss report (an export holding one is refused)', async () => {
    const entry = async (constituents: string) => analyzeConversionLoss(await parse(model('IFC4X3', `${BASE}\n${constituents}\n#5=IFCMATERIALPROPERTIES('Pset_x',$,(#6),#21);`)), 'IFC4X3', 'IFC2X3')
      .entries.find((e) => e.sourceType === 'IFCMATERIALPROPERTIES');
    expect(await entry("#20=IFCMATERIALCONSTITUENT('c',$,#9,0.5,$);\n#21=IFCMATERIALCONSTITUENTSET('s',$,(#20));")).toBeUndefined();
    expect((await entry("#20=IFCMATERIALCONSTITUENT('c',$,#9,0.5,$);\n#22=IFCMATERIALCONSTITUENT('d',$,#8,0.5,$);\n#21=IFCMATERIALCONSTITUENTSET('s',$,(#20,#22));"))?.expressIds).toEqual([5]);
  });

  it('checks the record and its referents as edited (/code-review)', async () => {
    const data = `#10=IFCMATERIALLAYER(#8,0.2,$,$,$,$,$);\n#12=IFCMATERIALLAYER(#9,0.1,$,$,$,$,$);\n#13=IFCMATERIALLAYERSET((#10,#12),'Wall',$);\n#5=IFCMATERIALPROPERTIES('Pset_x','d',(#6),#13);`;
    const edited = async (edit: (view: MutablePropertyView) => void) => {
      const store = await parse(model('IFC4', `${BASE}\n${data}`));
      const view = new MutablePropertyView(null, 'm');
      edit(view);
      const out = new TextDecoder().decode(new StepExporter(store, view).export({ schema: 'IFC2X3', applyMutations: true }).content);
      return out.split('\n').find((l) => l.startsWith('#5='));
    };
    // The layer edited to the other layer's material: the set now holds one.
    expect(await edited((view) => view.setPositionalAttribute(12, 0, '#8'))).toBe("#5=IFCEXTENDEDMATERIALPROPERTIES(#8,(#6),'d','Pset_x');");
    // The record's own Material edited to a material.
    expect(await edited((view) => view.setPositionalAttribute(5, 3, '#9'))).toBe("#5=IFCEXTENDEDMATERIALPROPERTIES(#9,(#6),'d','Pset_x');");
  });

  // Hosted CodeRabbit on #10781: the referents are the records the export writes.
  const LAYERED = `#10=IFCMATERIALLAYER(#8,0.2,$,$,$,$,$);\n#12=IFCMATERIALLAYER(#9,0.1,$,$,$,$,$);\n#13=IFCMATERIALLAYERSET((#10,#12),'Wall',$);\n#5=IFCMATERIALPROPERTIES('Pset_x','d',(#6),#13);`;
  const editedExport = async (data: string, edit: (view: MutablePropertyView, editor: StoreEditor) => void) => {
    const store = await parse(model('IFC4', `${BASE}\n${data}`));
    const view = new MutablePropertyView(null, 'm');
    edit(view, new StoreEditor(store, view));
    const result = new StepExporter(store, view).export({ schema: 'IFC2X3', applyMutations: true });
    return { lines: new TextDecoder().decode(result.content).split('\n'), warnings: result.stats.warnings };
  };

  it('resolves through an overlay-created layer as written', async () => {
    let created = 0;
    const { lines } = await editedExport('', (_view, editor) => {
      const layer = editor.addEntity('IfcMaterialLayer', ['#8', 0.2, null, null, null, null, null]);
      created = editor.addEntity('IfcMaterialProperties', ['Q', null, ['#6'], `#${layer.expressId}`]).expressId;
    });
    expect(lines.find((l) => l.startsWith(`#${created}=`))).toBe(`#${created}=IFCEXTENDEDMATERIALPROPERTIES(#8,(#6),$,'Q');`);
  });

  it('does not name a material retyped away', async () => {
    const { lines, warnings } = await editedExport("#5=IFCMATERIALPROPERTIES('Pset_x','d',(#6),#8);", (view) => view.setEntityType(8, 'IfcMaterialLayer'));
    expect(lines.find((l) => l.startsWith('#5='))).toBeUndefined();
    expect(warnings.join('\n')).toContain('IfcMaterialProperties record(s) were not written');
  });

  it('leaves a deleted layer out of its set, so the surviving layer names the material', async () => {
    const { lines, warnings } = await editedExport(LAYERED, (view) => view.deleteEntity(12));
    expect(lines.find((l) => l.startsWith('#5='))).toBe("#5=IFCEXTENDEDMATERIALPROPERTIES(#8,(#6),'d','Pset_x');");
    expect(warnings.join('\n')).not.toContain('IfcMaterialProperties record(s)');
  });

  it("resolves each merged model's referents in the merge's id space", async () => {
    const one = `#10=IFCMATERIALLAYER(#8,0.2,$,$,$,$,$);\n#13=IFCMATERIALLAYERSET((#10),'Wall',$);\n#5=IFCMATERIALPROPERTIES('Pset_x','d',(#6),#13);`;
    const models: MergeModelInput[] = [];
    for (const [id, data] of [['one', one], ['two', LAYERED]]) models.push({ id, name: id, dataStore: await parse(model('IFC4', `${BASE}\n${data}`)) });
    const result = new MergedExporter(models).export({ schema: 'IFC2X3' });
    const out = new TextDecoder().decode(result.content);
    // The first model's set names one material; the second's names two, so its record is not written.
    expect(out.split('\n').filter((l) => l.includes('=IFCEXTENDEDMATERIALPROPERTIES('))).toEqual(["#5=IFCEXTENDEDMATERIALPROPERTIES(#8,(#6),'d','Pset_x');"]);
    expect(out).not.toContain('IFCMATERIALPROPERTIES(');
    expect(result.stats.warnings.join('\n')).toContain('1 IfcMaterialProperties record(s) were not written');
  });

  it('checks a record without its semicolon like one with it (CodeRabbit)', () => {
    // No lookup proves #13 an IfcMaterial either way, so neither form is written.
    expect(convertStepLine("#5=IFCMATERIALPROPERTIES('P',$,(#6),#13);", 'IFC4', 'IFC2X3')).toBeNull();
    expect(convertStepLine("#5=IFCMATERIALPROPERTIES('P',$,(#6),#13)", 'IFC4', 'IFC2X3')).toBeNull();
  });

  it('leaves out and names a record it cannot read (/code-review)', () => {
    const referents = new MaterialReferents({ typeOf: (id) => (id === 8 ? 'IFCMATERIAL' : undefined), slots: () => undefined });
    expect(referents.apply("#5=IFCMATERIALPROPERTIES('P',$,(#6),#8);", 'IFC4', 'IFC2X3')).toBe("#5=IFCMATERIALPROPERTIES('P',$,(#6),#8);");
    const commented = "#5=IFCMATERIALPROPERTIES('P',$,(#6),#8);/* c */";
    expect(referents.apply(commented, 'IFC4', 'IFC2X3'), "a comment after the ';' is no missing ';'").toBe(commented);
    expect(referents.apply("#7=IFCMATERIALPROPERTIES('P',$,(#6,#8);", 'IFC4', 'IFC2X3')).toBeNull();
    expect(referents.warnings().join()).toContain('#7 (unreadable)');
    expect(referents.apply("/* was #3 */#9=IFCMATERIALPROPERTIES('P',$,(#6),$);", 'IFC4', 'IFC2X3')).toBeNull();
    expect(referents.warnings().join()).toContain('#9 (no Material)');
    // A record without its ';' is rewritten without one.
    const layered = new MaterialReferents({ typeOf: (id) => ({ 8: 'IFCMATERIAL', 10: 'IFCMATERIALLAYER' })[id], slots: (id) => (id === 10 ? ['#8', '0.2', '$', '$', '$', '$', '$'] : undefined) });
    expect(layered.apply("#5=IFCMATERIALPROPERTIES('P',$,(#6),#10)", 'IFC4', 'IFC2X3')).toBe("#5=IFCMATERIALPROPERTIES('P',$,(#6),#8)");
    expect(layered.apply("#5=IFCMATERIALPROPERTIES('P',$,(#6),#10);/* c */", 'IFC4', 'IFC2X3')).toBe("#5=IFCMATERIALPROPERTIES('P',$,(#6),#8);/* c */");
  });
});
