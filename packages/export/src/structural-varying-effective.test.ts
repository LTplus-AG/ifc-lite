/* SPDX-License-Identifier: MPL-2.0 */
import { readFileSync } from 'node:fs';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { IfcParser } from '@ifc-lite/parser';
import { expect, it } from 'vitest';
import { StepExporter } from './step-exporter.js';

it('converts the retained or edited varying action and its effective loads (#11037)', async () => {
  const file = new URL('../../../rust/export/tests/fixtures/structural_carriers_parity.json', import.meta.url);
  const fixture = JSON.parse(readFileSync(file, 'utf8')) as { owner: string; cases: { why: string; data: string }[] };
  const sample = fixture.cases.find((entry) => entry.why.startsWith('a converted varying action:'));
  expect(sample).toBeDefined();
  const body = "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('t','',(''),(''),'','','');\nFILE_SCHEMA(('IFC2X3'));\nENDSEC;\nDATA;\n"
    + fixture.owner + "\n" + sample!.data + "\nENDSEC;\nEND-ISO-10303-21;\n";
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(body).buffer);
  const subset = new StepExporter(store).export({ schema: 'IFC4', subsetEntityIds: new Set([30, 20]) });
  const view = new MutablePropertyView(store.properties, 'varying');
  view.setPositionalAttribute(30, 13, ['#18', '#19']);
  const edited = new StepExporter(store, view).export({ schema: 'IFC4' });
  for (const [result, loads] of [[subset, '#11,#19,#18'], [edited, '#11,#18,#19']] as const) {
    const output = new TextDecoder().decode(result.content);
    const configuration = /#(\d+)=IFCSTRUCTURALLOADCONFIGURATION\(/.exec(output)?.[1];
    expect(configuration).toBeDefined();
    expect(output).toContain('IFCSTRUCTURALLOADCONFIGURATION($,(' + loads + '),$);');
    expect(output).toContain('#30=IFCSTRUCTURALCURVEACTION(');
    expect(output).toContain("'Causes',$,(#20),$,#30);");
    expect(output).not.toContain('IFCSTRUCTURALLINEARACTIONVARYING(');
  }
  view.setPositionalAttribute(30, 12, '#9999');
  const fallback = new StepExporter(store, view).export({ schema: 'IFC4' });
  const fallbackText = new TextDecoder().decode(fallback.content);
  expect(fallbackText).toContain('#30=IFCSTRUCTURALCURVEACTION(');
  expect(fallbackText).toContain(",#11,.GLOBAL_COORDS.,.F.,.TRUE_LENGTH.,.CONST.);");
  expect(fallbackText).toContain("'Causes',$,(#20),$,#30);");
  expect(fallbackText).not.toContain('IFCSTRUCTURALLOADCONFIGURATION(');
  expect(fallback.stats.warnings.join(' ')).toContain('no complete load configuration');
});
