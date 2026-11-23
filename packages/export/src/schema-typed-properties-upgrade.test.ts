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
