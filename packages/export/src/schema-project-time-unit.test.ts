/* SPDX-License-Identifier: MPL-2.0 */
import { readFileSync } from 'node:fs';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { IfcParser } from '@ifc-lite/parser';
import { expect, it } from 'vitest';
import { StepExporter } from './step-exporter.js';
import { MergedExporter } from './merged-exporter.js';

const minutes = readFileSync(new URL('../../../rust/export/tests/fixtures/schema_duration_timeunit.ifc', import.meta.url), 'utf8')
  .replace('10.,$,$,$,.ACTUAL.', '10.,-2.,$,$,.ACTUAL.');
const seconds = minutes.replace('((#6))', '((#3))').replace('1Yvct', '2Yvct').replace('IFCWORKPLAN(', 'IFCWORKSCHEDULE(');
const parse = (text: string) => new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer);
const decode = (result: {content: Uint8Array}) => new TextDecoder().decode(result.content);

for (const schema of ['IFC4', 'IFC4X3'] as const) {
  it(`uses each source project's unit on upgrade and the retained project on downgrade via ${schema} (#11192)`, async () => {
    const stores = await Promise.all([parse(minutes), parse(seconds)]);
    const direct = new StepExporter(stores[0]).export({schema});
    expect(decode(direct)).toMatch(/IFCWORKPLAN\([^;]*'PT600S','-PT120S'/);
    expect(direct.stats.warnings.join(' ')).not.toContain('assumed seconds');
    const models = stores.map((dataStore, i) => ({ id: String(i), name: String(i), dataStore }));
    const merged = new MergedExporter(models);
    for (const result of [merged.export({ schema }), await merged.exportAsync({ schema })]) {
      expect(decode(result)).toMatch(/IFCWORKPLAN\([^;]*'PT600S','-PT120S'/);
      expect(decode(result)).toMatch(/IFCWORKSCHEDULE\([^;]*'PT10S','-PT2S'/);
    }
    const modern = await Promise.all(stores.map(store => parse(decode(new StepExporter(store).export({schema})))));
    const down = new MergedExporter(modern.map((dataStore, i) => ({id: String(i), name: String(i), dataStore})));
    for (const result of [down.export({schema:'IFC2X3'}), await down.exportAsync({schema:'IFC2X3'})]) {
      expect(decode(result)).toMatch(/IFCWORKPLAN\([^;]*,10\.,-2\.,/);
      expect(decode(result)).toMatch(/IFCWORKSCHEDULE\([^;]*,0\.16666666666666666,-0\.03333333333333333,/);
    }
    const view = new MutablePropertyView(modern[1].properties, 'time edits');
    view.setPositionalAttribute(3, 2, '.MILLI.');
    const edited = new StepExporter(modern[1], view).export({schema:'IFC2X3'});
    expect(decode(edited)).toContain('IFCSIUNIT(*,.TIMEUNIT.,.MILLI.,.SECOND.)');
    expect(decode(edited)).toMatch(/IFCWORKSCHEDULE\([^;]*,10000\.,-2000\.,/);
    expect(edited.stats.warnings.join(' ')).not.toContain('assumed seconds');
    const subset = new StepExporter(stores[0]).export({schema,subsetEntityIds:new Set([7])});
    expect(decode(subset)).toMatch(/IFCWORKPLAN\([^;]*'PT600S','-PT120S'/);
  });
}

it('warns once on conflicting time units or a cyclic conversion factor (#11192)', async () => {
  for (const text of [minutes.replace('((#6))','((#6,#3))'),minutes.replace('IFCRATIOMEASURE(60.),#3','IFCRATIOMEASURE(60.),#6'),
    ...['IFCLABEL(60.)', 'IFCINTEGER(60.5)', 'IFCNORMALISEDRATIOMEASURE(60.)', 'IFCRATIOMEASURE(0.)']
      .map(value => minutes.replace('IFCRATIOMEASURE(60.)', value))]) {
    const result = new StepExporter(await parse(text)).export({schema:'IFC4'});
    expect(decode(result)).toContain("'PT10S','-PT2S'");
    expect(result.stats.warnings.filter(w => w.includes('assumed seconds'))).toHaveLength(1);
  }
});
