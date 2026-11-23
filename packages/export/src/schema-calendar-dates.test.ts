/* SPDX-License-Identifier: MPL-2.0 */
import { readFileSync } from 'node:fs';
import { IfcParser } from '@ifc-lite/parser';
import { expect, it } from 'vitest';
import { MergedExporter } from './merged-exporter.js';
import { StepExporter } from './step-exporter.js';

const { calendarWarnings } = JSON.parse(readFileSync(
  new URL('../../../rust/export/tests/fixtures/schema_value_form_vectors.json', import.meta.url), 'utf8',
)) as { calendarWarnings: string[] };

it('keeps calendar dates, fractional seconds and timezone offsets across schema versions (#10879)', async () => {
  const bytes = readFileSync(new URL('../../../rust/export/tests/fixtures/schema_calendar_dates.ifc', import.meta.url));
  const parser = new IfcParser();
  const source = await parser.parseColumnar(Uint8Array.from(bytes).buffer);
  const primary = new StepExporter(source).export({ schema: 'IFC4' });
  const output = new TextDecoder().decode(primary.content);
  expect(output).toContain("#1=IFCCLASSIFICATION('Source','1','2024-02-29','Classification',$,$,$);");
  expect(output).toContain("#3=IFCIRREGULARTIMESERIESVALUE('2024-02-29T10:30:15.5+05:30',(IFCREAL(1.)));");
  expect(output).toContain("#7=IFCCOSTVALUE('Estimate',$,$,$,'2024-02-29','2024-02-29','Materials',$,$,$);");
  expect(primary.stats.warnings).toEqual(calendarWarnings);
  expect(primary.stats.entityCount).toBe([...output.matchAll(/^#\d+=/gm)].length);
  expect(output).not.toMatch(/=IFC(CALENDARDATE|DATEANDTIME|LOCALTIME|COORDINATEDUNIVERSALTIMEOFFSET)\(/);
  const converted = await parser.parseColumnar(Uint8Array.from(primary.content).buffer);
  const merged = new MergedExporter([{ id: 'm', name: 'Dates', dataStore: converted }]);
  const options = { schema: 'IFC2X3', projectStrategy: 'keep-first' } as const;
  for (const result of [new StepExporter(converted).export(options), merged.export(options), await merged.exportAsync(options)]) {
    const text = new TextDecoder().decode(result.content);
    expect(text).toMatch(/IFCCLASSIFICATION\('Source','1',#\d+,'Classification'\);/);
    expect(text).toContain('IFCCALENDARDATE(29,2,2024);');
    expect(text).toMatch(/IFCLOCALTIME\(10,30,15\.5,#\d+,\$\);/);
    expect(text).toContain('IFCCOORDINATEDUNIVERSALTIMEOFFSET(5,30,.AHEAD.);');
  }
});

it('warns when converting a duration with a non-second project TIMEUNIT (#10879)', async () => {
  const bytes = readFileSync(new URL('../../../rust/export/tests/fixtures/schema_duration_timeunit.ifc', import.meta.url));
  const parser = new IfcParser();
  const legacy = await parser.parseColumnar(Uint8Array.from(bytes).buffer);
  const upgraded = new StepExporter(legacy).export({ schema: 'IFC4' });
  const modern = await parser.parseColumnar(Uint8Array.from(upgraded.content).buffer);
  for (const [store, schema, duration] of [[legacy, 'IFC4', "'PT10S'"], [modern, 'IFC2X3', '10.']] as const) {
    const merged = new MergedExporter([{ id: 'm', name: 'Plan', dataStore: store }]);
    const options = { schema, projectStrategy: 'keep-first' } as const;
    for (const result of [new StepExporter(store).export(options), merged.export(options), await merged.exportAsync(options)]) {
      expect(new TextDecoder().decode(result.content)).toContain(`,'id',$,$,$,${duration},`);
      expect(result.stats.warnings.join(' ')).toContain('assumed seconds');
    }
  }
  const seconds = new TextEncoder().encode(bytes.toString().replace('IFCUNITASSIGNMENT((#6))', 'IFCUNITASSIGNMENT((#3))'));
  const store = await parser.parseColumnar(seconds.buffer as ArrayBuffer);
  expect(new StepExporter(store).export({ schema: 'IFC4' }).stats.warnings.join(' ')).not.toContain('assumed seconds');
});
