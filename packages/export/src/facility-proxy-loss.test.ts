/* SPDX-License-Identifier: MPL-2.0 */
import { readFileSync } from 'node:fs';
import { IfcParser } from '@ifc-lite/parser';
import { expect, it } from 'vitest';
import { StepExporter } from './step-exporter.js';
import { analyzeConversionLoss } from './schema-conversion-loss-report.js';

type Schema = 'IFC2X3' | 'IFC4' | 'IFC4X3';
const routes: [Schema, string, string][] = JSON.parse(readFileSync(
  new URL('../../../rust/export/tests/fixtures/proxy_classification_routes.json', import.meta.url), 'utf8'));

async function convert(from: Schema, to: Schema, type: string, tail: string) {
  const source = `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('test.ifc','',(''),(''),'','','');\nFILE_SCHEMA(('${from}'));\nENDSEC;\nDATA;\n#1=${type}('0YvctVUKr0kugbFTf53O9L',$,'sample',$,$,$,$,$,${tail});\nENDSEC;\nEND-ISO-10303-21;\n`;
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(source).buffer);
  const result = new StepExporter(store).export({ schema: to });
  return { line: new TextDecoder().decode(result.content).split('\n').find(line => line.startsWith('#1=')),
    warnings: result.stats.warnings.join('\n'), preview: analyzeConversionLoss(store, from, to).entries };
}

it.each(['IFC4', 'IFC2X3'] as const)('omits direct facility UsageType from storey Elevation in %s (#11589)', async to => {
  const result = await convert('IFC4X3', to, 'IFCFACILITYPART', '.ELEMENT.,.LATERAL.');
  expect(result.line).toMatch(/^#1=IFCBUILDINGSTOREY\(.*,\.ELEMENT\.,\$\);$/);
  expect(result.warnings).toContain('IFCFACILITYPART.UsageType');
  expect(result.preview).toContainEqual(expect.objectContaining({ expressIds: [1], droppedAttributes: ['UsageType'] }));
  expect((await convert('IFC4X3', to, 'IFCFACILITYPART', '.ELEMENT.,$')).warnings).not.toContain('UsageType');
});

it.each(routes)('%s %s reports the lost source classification .%s. (#11589)', async (from, type, member) => {
  const result = await convert(from, 'IFC2X3', type, `/* classification */ .${member}.`);
  expect(result.line).toMatch(/^#1=IFCBUILDINGELEMENTPROXY\(.*,\$\);$/);
  expect(result.warnings).toContain(`.${member}. (source ${type}.PredefinedType)`);
  expect(result.preview).toContainEqual(expect.objectContaining({ expressIds: [1], droppedAttributes: ['PredefinedType'] }));
});

it('retains compatible proxy composition on upgrade (#11589)', async () => {
  const result = await convert('IFC2X3', 'IFC4', 'IFCBUILDINGELEMENTPROXY', '.ELEMENT.');
  expect(result.line).toMatch(/,\.ELEMENT\.\);$/);
  expect(result.warnings).not.toContain('CompositionType');
});
