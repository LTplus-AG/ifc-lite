/* SPDX-License-Identifier: MPL-2.0 */
import { readFileSync } from 'node:fs';
import { IfcParser } from '@ifc-lite/parser';
import { expect, it } from 'vitest';
import { MergedExporter } from './merged-exporter.js';
import { analyzeConversionLoss } from './schema-conversion-loss-report.js';
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
  // #11199: ApplicableDate (#4) and FixedUntilDate (#8) are different dates, so a swap shows.
  expect(output).toContain("#7=IFCCOSTVALUE('Estimate',$,$,$,'2024-02-29','2024-03-01','Materials',$,$,$);");
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
    expect(text).toContain('IFCCALENDARDATE(1,3,2024);');
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

const legacy = (data: string) => new IfcParser().parseColumnar(new TextEncoder().encode(`ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC2X3'));
ENDSEC;
DATA;
#1=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'P',$,$,$,$,$,$);
${data}
ENDSEC;
END-ISO-10303-21;
`).buffer as ArrayBuffer);

it('leaves out an IFC2X3 date record nothing references, even when no slot converts (#11199)', async () => {
  const store = await legacy('#2=IFCCALENDARDATE(29,2,2024);\n#3=IFCLOCALTIME(10,30,$,$,$);');
  for (const schema of ['IFC4', 'IFC4X3'] as const) {
    const result = new StepExporter(store).export({ schema });
    const text = new TextDecoder().decode(result.content);
    expect(text).not.toMatch(/=IFC(CALENDARDATE|LOCALTIME)\(/);
    expect(result.stats.entityCount).toBe([...text.matchAll(/^#\d+=/gm)].length);
    expect(result.stats.warnings.join('\n')).not.toContain('still referenced');
    expect(result.stats.warnings.join('\n')).not.toContain('readers may reject');
    expect(result.stats.warnings).toContain('2 legacy IFC2X3 date record(s) were omitted because no written record references them and the target schema does not declare their type: #2 (IFCCALENDARDATE), #3 (IFCLOCALTIME) (#11199).');
    const preview = analyzeConversionLoss(store, 'IFC2X3', schema).describe().join('\n');
    expect(preview).toContain('IFCCALENDARDATE (#2) will be omitted because no written record references it');
    expect(preview).toContain('IFCLOCALTIME (#3) will be omitted because no written record references it');
  }
});

it('reports a clock whose minute or second the IFC2X3 source left unset (#11199)', async () => {
  const store = await legacy(`#2=IFCCALENDARDATE(29,2,2024);
#4=IFCDATEANDTIME(#2,#5);
#5=IFCLOCALTIME(10,$,$,$,$);
#3=IFCIRREGULARTIMESERIESVALUE(#4,(IFCREAL(1.)));
#6=IFCLOCALTIME(10,30,15.,$,$);
#7=IFCDATEANDTIME(#2,#6);
#8=IFCIRREGULARTIMESERIESVALUE(#7,(IFCREAL(2.)));`);
  for (const schema of ['IFC4', 'IFC4X3'] as const) {
    const result = new StepExporter(store).export({ schema });
    const text = new TextDecoder().decode(result.content);
    expect(text).toContain("#3=IFCIRREGULARTIMESERIESVALUE('2024-02-29T10:00:00',(IFCREAL(1.)));");
    expect(text).toContain("#8=IFCIRREGULARTIMESERIESVALUE('2024-02-29T10:30:15',(IFCREAL(2.)));");
    expect(result.stats.warnings).toContain(
      '1 time value(s) wrote an unset minute or second as 00, a precision the IFC2X3 source does not state: IFCIRREGULARTIMESERIESVALUE.TimeStamp (#11199).');
  }
});

it('names a date record whose only referrer is written as IFCPROXY, in the export and the preview alike (#11199)', async () => {
  const store = await legacy("#2=IFCCALENDARDATE(29,2,2024);\n#10=IFCTIMESERIESSCHEDULE('1YvctVUKr0kugbFTf53O9L',$,'S',$,$,(#2),.WEEKLY.,$);");
  const result = new StepExporter(store).export({ schema: 'IFC4' });
  const text = new TextDecoder().decode(result.content);
  expect(text).toMatch(/^#10=IFCPROXY\(/m);
  expect(text).not.toContain('=IFCCALENDARDATE(');
  expect(result.stats.warnings.join('\n')).toContain('were omitted because no written record references them and the target schema does not declare their type: #2 (IFCCALENDARDATE)');
  expect(analyzeConversionLoss(store, 'IFC2X3', 'IFC4').describe().join('\n')).toContain('IFCCALENDARDATE (#2) will be omitted because no written record references it');
});

it('keeps a date record a type neither schema declares still references, in the preview as in the export (#11199)', async () => {
  const store = await legacy('#2=IFCCALENDARDATE(29,2,2024);\n#3=IFCVENDORRESOURCE(#2);');
  const text = new TextDecoder().decode(new StepExporter(store).export({ schema: 'IFC4' }).content);
  expect(text).toContain('#2=IFCCALENDARDATE(29,2,2024);');
  expect(analyzeConversionLoss(store, 'IFC2X3', 'IFC4').describe().join('\n')).not.toContain('IFCCALENDARDATE (#2) will be omitted');
});
