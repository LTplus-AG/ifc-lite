/* SPDX-License-Identifier: MPL-2.0 */
import { readFileSync } from 'node:fs';
import { IfcParser } from '@ifc-lite/parser';
import { expect, it } from 'vitest';
import { MergedExporter } from './merged-exporter.js';

type Case = { name: string; target: 'IFC4' | 'IFC4X3'; laterSchema: string; first: string; later: string; keptType: string; omittedType: string };
const cases = JSON.parse(readFileSync(new URL('../../../rust/export/tests/fixtures/schema_merge_pruned_guids.json', import.meta.url), 'utf8')) as Case[];
const project = "#30=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'Shared',$,$,$,$,$,$);";
const links = "#34=IFCGROUP('2YvctVUKr0kugbFTf53O9L',$,'Group',$,$);\n#35=IFCRELASSIGNSTOGROUP('3YvctVUKr0kugbFTf53O9L',$,$,$,(#33),$,#34);";

function parse(schema: string, records: string) {
  const source = `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('t.ifc','',(''),(''),'','','');\nFILE_SCHEMA(('${schema}'));\nENDSEC;\nDATA;\n${project}\n${records}\nENDSEC;\nEND-ISO-10303-21;\n`;
  return new IfcParser().parseColumnar(new TextEncoder().encode(source).buffer);
}

it.each(cases)('keeps a valid duplicate after the earlier $name is omitted (#11129)', async ({ target, laterSchema, first, later, keptType, omittedType }) => {
  const merged = new MergedExporter([
    { id: 'first', name: 'First', dataStore: await parse('IFC2X3', first) },
    { id: 'later', name: 'Later', dataStore: await parse(laterSchema, `${later}\n${links}`) },
  ]);
  const options = { schema: target, projectStrategy: 'keep-first', unitReconciliation: 'assume-shared' } as const;
  for (const result of [merged.export(options), await merged.exportAsync(options)]) {
    const lines = new TextDecoder().decode(result.content).split('\n');
    const survivors = lines.filter(line => line.includes(`=${keptType}('1YvctVUKr0kugbFTf53O9L',$,'Kept'`));
    expect(survivors).toHaveLength(1);
    const id = survivors[0].split('=')[0];
    expect(lines.find(line => line.includes('=IFCRELASSIGNSTOGROUP('))).toContain(`,(${id}),$,`);
    expect(result.stats.warnings.join(' ')).toContain(`#33 (${omittedType}) was omitted`);
  }
});

it('keeps the GlobalId of a relationship a later fold keeps after its first member is omitted (#11129)', async () => {
  const { first, later } = JSON.parse(readFileSync(new URL('../../../rust/export/tests/fixtures/schema_merge_fold_guid.json', import.meta.url), 'utf8')) as { first: string; later: string };
  const merged = new MergedExporter([
    { id: 'first', name: 'First', dataStore: await parse('IFC2X3', first) },
    { id: 'later', name: 'Later', dataStore: await parse('IFC2X3', later) },
  ]);
  const options = { schema: 'IFC4', projectStrategy: 'keep-first', unitReconciliation: 'assume-shared' } as const;
  for (const result of [merged.export(options), await merged.exportAsync(options)]) {
    const text = new TextDecoder().decode(result.content);
    const guids = [...text.matchAll(/^#\d+=IFC\w+\('([0-9A-Za-z_$]{22})'/gm)].map(m => m[1]);
    expect(guids.filter((guid, index) => guids.indexOf(guid) !== index)).toEqual([]);
    expect(text).toMatch(/=IFCRELDEFINESBYTYPE\('5YvctVUKr0kugbFTf53O9L',\$,'Pruned, then folded',\$,\(#\d+\),#\d+\);/);
  }
});
