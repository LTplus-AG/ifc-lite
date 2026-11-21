/* SPDX-License-Identifier: MPL-2.0 */
import { readFileSync } from 'node:fs';
import { IfcParser } from '@ifc-lite/parser';
import { expect, it } from 'vitest';
import { MergedExporter } from './merged-exporter.js';
import { StepExporter } from './step-exporter.js';

it('keeps calendar dates, fractional seconds and timezone offsets across schema versions (#10879)', async () => {
  const bytes = readFileSync(new URL('../../../rust/export/tests/fixtures/schema_calendar_dates.ifc', import.meta.url));
  const parser = new IfcParser();
  const source = await parser.parseColumnar(Uint8Array.from(bytes).buffer);
  const primary = new StepExporter(source).export({ schema: 'IFC4' });
  const output = new TextDecoder().decode(primary.content);
  expect(output).toContain("#1=IFCCLASSIFICATION('Source','1','2024-02-29','Classification',$,$,$);");
  expect(output).toContain("#3=IFCIRREGULARTIMESERIESVALUE('2024-02-29T10:30:15.5+05:30',(IFCREAL(1.)));");
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
