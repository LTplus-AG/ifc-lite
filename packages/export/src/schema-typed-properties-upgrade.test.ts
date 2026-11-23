/* SPDX-License-Identifier: MPL-2.0 */

import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { MergedExporter } from './merged-exporter.js';
import { analyzeConversionLoss } from './schema-conversion-loss-report.js';
import { StepExporter } from './step-exporter.js';
import { attrNameTable } from './schema-converter.js';

it('keeps typed IFC2X3 measures in IFC4 property single values (#10797)', async () => {
  const source = readFileSync(new URL('../../../rust/export/tests/fixtures/schema_typed_properties_upgrade.ifc', import.meta.url));
  const store = await new IfcParser().parseColumnar(Uint8Array.from(source).buffer);
  for (const schema of ['IFC4', 'IFC4X3'] as const) {
    const model = { id: 'm', name: 'typed', dataStore: store };
    const merged = new MergedExporter([model]);
    const options = { schema, projectStrategy: 'keep-first' } as const;
    for (const result of [new StepExporter(store).export(options), merged.export(options), await merged.exportAsync(options)]) {
      const output = new TextDecoder().decode(result.content);
      expect(output).toMatch(/#2=IFCMATERIALPROPERTIES\('Pset_MaterialConcrete',\$,\(#\d+(,#\d+)*\),#1\);/);
      expect(output).toMatch(/IFCMATERIALPROPERTIES\('Pset_MaterialMechanical',\$,\(#\d+(,#\d+)*\),#1\);/);
      expect(output).toMatch(/#4=IFCPROFILEPROPERTIES\('Pset_ProfileMechanical',\$,\(#\d+(,#\d+)*\),#3\);/);
      expect(output).toContain("IFCPROPERTYSINGLEVALUE('YoungModulus',$,IFCMODULUSOFELASTICITYMEASURE(25000000000.),$);");
      expect(output).toContain("IFCPROPERTYSINGLEVALUE('CompressiveStrength',$,IFCPRESSUREMEASURE(30000000.),$);");
      expect(output).toContain("IFCPROPERTYSINGLEVALUE('MassPerLength',$,IFCMASSPERLENGTHMEASURE(4.5),$);");
    }
    const loss = analyzeConversionLoss(store, 'IFC2X3', schema);
    expect(loss.entries.flatMap((entry) => entry.droppedAttributes)).not.toContain('YoungModulus');
  }
});

it('reports the lost profile name without reporting its carried mass (#10797)', async () => {
  const source = readFileSync(new URL('../../../rust/export/tests/fixtures/schema_typed_properties_upgrade.ifc', import.meta.url), 'utf8');
  const count = attrNameTable('IFC2X3')?.get('IFCSTRUCTURALSTEELPROFILEPROPERTIES')?.length ?? 0;
  const slots = ["'legacy'", '#3', '4.5', ...Array<string>(count - 3).fill('$')];
  const input = source.replace(/#4=IFCGENERALPROFILEPROPERTIES[^;]+;/, '#4=IFCSTRUCTURALSTEELPROFILEPROPERTIES(' + slots.join(',') + ');');
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(input).buffer);
  const result = new StepExporter(store).export({ schema: 'IFC4' });
  const warnings = result.stats.warnings.join(' ');
  expect(warnings).toContain('ProfileName has no slot');
  expect(warnings).not.toContain('PhysicalWeight has no slot');
});

it('reports only the material density whose required material is missing (#10797)', async () => {
  const source = readFileSync(new URL('../../../rust/export/tests/fixtures/schema_typed_properties_upgrade.ifc', import.meta.url), 'utf8');
  const input = source.replace('ENDSEC;\nEND-ISO',
    '#7=IFCGENERALMATERIALPROPERTIES($,$,$,42.);\n#8=IFCGENERALMATERIALPROPERTIES(#1,$,$,84.);\nENDSEC;\nEND-ISO');
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(input).buffer);
  for (const schema of ['IFC4', 'IFC4X3'] as const) {
    const result = new StepExporter(store).export({ schema });
    const output = new TextDecoder().decode(result.content);
    expect(output).toContain('IFCMASSDENSITYMEASURE(84.)');
    expect(output).not.toContain('IFCMASSDENSITYMEASURE(42.)');
    expect(result.stats.warnings.join(' ')).toContain('typed property record(s) could not be preserved');
    expect(analyzeConversionLoss(store, 'IFC2X3', schema).entries.find(entry => entry.sourceType === 'IFCGENERALMATERIALPROPERTIES'))
      .toMatchObject({ kind: 'lossy', expressIds: [7], droppedAttributes: ['MassDensity'] });
  }
});

it('keeps typed MassDensity with raw Latin-1 in another DATA record (#10797)', async () => {
  const source = readFileSync(new URL('../../../rust/export/tests/fixtures/schema_typed_properties_latin1.ifc', import.meta.url));
  expect(() => new TextDecoder('utf-8', { fatal: true }).decode(source)).toThrow();
  const store = await new IfcParser().parseColumnar(Uint8Array.from(source).buffer);
  const merged = new MergedExporter([{ id: 'm', name: 'typed', dataStore: store }]);
  const options = { schema: 'IFC4', projectStrategy: 'keep-first' } as const;
  const outputs = [
    ['direct', new StepExporter(store).export(options)],
    ['merged', merged.export(options)],
    ['async merged', await merged.exportAsync(options)],
  ] as const;
  for (const [writer, result] of outputs) {
    const output = new TextDecoder().decode(result.content);
    expect(output, writer).toContain("IFCPROPERTYSINGLEVALUE('MassDensity',$,IFCMASSDENSITYMEASURE(42.),$);");
    expect(output, writer).toContain("IFCMATERIAL('B�ton',$,$);");
  }
});

const writerVectors: Array<{ name: string; source: string; expected: string[] }> = JSON.parse(readFileSync(
  new URL('../../../rust/export/tests/fixtures/schema_typed_properties_writer_vectors.json', import.meta.url), 'utf8',
));

it.each(writerVectors)('writes matching STEP records in every writer for $name (#10797)', async ({ name, source, expected }) => {
  const input = Buffer.from("ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC2X3'));\nENDSEC;\nDATA;\n"
    + source + '\nENDSEC;\nEND-ISO-10303-21;\n', 'latin1');
  const store = await new IfcParser().parseColumnar(Uint8Array.from(input).buffer);
  const merged = new MergedExporter([{ id: 'typed-vector', name, dataStore: store }]);
  const options = { schema: 'IFC4', projectStrategy: 'keep-first' } as const;
  const outputs = [
    ['direct', new StepExporter(store).export(options)],
    ['merged', merged.export(options)],
    ['async merged', await merged.exportAsync(options)],
  ] as const;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (const [writer, { content }] of outputs) {
    const records = decoder.decode(content).split('\n').map(line => line.slice(line.indexOf('=') + 1));
    expect(records, writer).toEqual(expect.arrayContaining(expected));
  }
});

it('uses the last STEP id on each export of the same typed properties (#10797)', async () => {
  const source = "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC2X3'));\nENDSEC;\nDATA;\n"
    + "#1=IFCMATERIAL('Steel');\n#4294967294=IFCGENERALMATERIALPROPERTIES(#1,$,$,7850.);\n"
    + 'ENDSEC;\nEND-ISO-10303-21;\n';
  const data = await new IfcParser().parseColumnar(new TextEncoder().encode(source).buffer);
  const exporter = new StepExporter(data);
  const options = { schema: 'IFC4' } as const;
  const property = "#4294967295=IFCPROPERTYSINGLEVALUE('MassDensity',$,IFCMASSDENSITYMEASURE(7850.),$);";
  const decoder = new TextDecoder();
  expect(decoder.decode(exporter.export(options).content)).toContain(property);
  expect(decoder.decode(exporter.export(options).content)).toContain(property);
});

it('reports the typed value whose allocation would exceed the STEP id limit (#10797)', async () => {
  const source = "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC2X3'));\nENDSEC;\nDATA;\n"
    + "#1=IFCMATERIAL('Steel');\n#4294967294=IFCGENERALMATERIALPROPERTIES(#1,$,$,7850.);\n"
    + '#2=IFCGENERALMATERIALPROPERTIES(#1,$,$,7800.);\nENDSEC;\nEND-ISO-10303-21;\n';
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(source).buffer);
  const exported = new StepExporter(store).export({ schema: 'IFC4' });
  const content = new TextDecoder().decode(exported.content);
  expect(content).toContain('IFCMASSDENSITYMEASURE(7800.)');
  expect(content).not.toContain('IFCMASSDENSITYMEASURE(7850.)');
  expect(analyzeConversionLoss(store, 'IFC2X3', 'IFC4').entries).toContainEqual(expect.objectContaining({
    sourceType: 'IFCGENERALMATERIALPROPERTIES',
    expressIds: [4294967294],
    droppedAttributes: ['MassDensity'],
  }));
});

it('normalizes converted typed property lengths and areas in sync and async merges (#10797)', async () => {
  const parser = new IfcParser();
  const read = (source: string) => parser.parseColumnar(new TextEncoder().encode(source).buffer);
  const unitAssignment = (prefix: string, guid: string) =>
    `#10=IFCPROJECT('${guid}',$,'Project',$,$,$,$,$,#11);\n`
    + '#11=IFCUNITASSIGNMENT((#12,#13));\n'
    + `#12=IFCSIUNIT(*,.LENGTHUNIT.,${prefix},.METRE.);\n`
    + `#13=IFCSIUNIT(*,.AREAUNIT.,${prefix},.SQUARE_METRE.);\n`;
  const primary = await read("ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n"
    + unitAssignment('$', '0123456789012345678901') + 'ENDSEC;\nEND-ISO-10303-21;\n');
  const fixture = readFileSync(new URL('../../../rust/export/tests/fixtures/schema_typed_properties_upgrade.ifc', import.meta.url), 'utf8');
  const secondary = await read(fixture.replace("0.02,'plastic'", "/* mm */20.,'plastic'").replace('4.5,$,$,$,0.06', '4.5,$,$,$,60000.')
    .replace('DATA;\n', 'DATA;\n' + unitAssignment('.MILLI.', '1123456789012345678901')));
  const exporter = new MergedExporter([
    { id: 'm', name: 'metres', dataStore: primary, lengthUnitScale: 1 },
    { id: 'mm', name: 'millimetres', dataStore: secondary, lengthUnitScale: 0.001 },
  ]);
  const options = { schema: 'IFC4', unitReconciliation: 'normalize' } as const;
  for (const result of [exporter.export(options), await exporter.exportAsync(options)]) {
    expect(result.stats.normalizedModelCount).toBe(1);
    const output = new TextDecoder().decode(result.content);
    expect(output).toContain("IFCPROPERTYSINGLEVALUE('MaxAggregateSize',$,IFCPOSITIVELENGTHMEASURE(0.02),$);");
    expect(output).toContain("IFCPROPERTYSINGLEVALUE('CrossSectionArea',$,IFCAREAMEASURE(0.06),$);");
  }
});
