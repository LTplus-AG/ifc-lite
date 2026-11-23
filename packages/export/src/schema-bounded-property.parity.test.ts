/* SPDX-License-Identifier: MPL-2.0 */
import { readFileSync } from 'node:fs';
import { IfcParser } from '@ifc-lite/parser';
import { describe, expect, it } from 'vitest';
import { MergedExporter } from './merged-exporter.js';
import { StepExporter } from './step-exporter.js';

interface Case {
  why: string;
  from: 'IFC4' | 'IFC4X3';
  line: string;
  expect?: string;
  dropped?: string;
}

const cases: Case[] = JSON.parse(readFileSync(
  new URL('../../../rust/export/tests/fixtures/schema_bounded_property_vectors.json', import.meta.url),
  'utf8',
));

describe('IFC2X3 bounded property WR22 (#11117)', () => {
  for (const row of cases) {
    it(`${row.from}: ${row.why}`, async () => {
      const schema = row.from === 'IFC4X3' ? 'IFC4X3_ADD2' : row.from;
      const input = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('fixture','',(''),(''),'','','');
FILE_SCHEMA(('${schema}'));
ENDSEC;
DATA;
${row.line}
ENDSEC;
END-ISO-10303-21;
`;
      const store = await new IfcParser().parseColumnar(new TextEncoder().encode(input).buffer, { disableWorkerScan: true });
      const exporter = new StepExporter(store);
      const merge = () => new MergedExporter([{ id: 'bounds', name: 'Bounds', dataStore: store }]).export({ schema: 'IFC2X3' });
      if (!row.expect) {
        expect(() => exporter.export({ schema: 'IFC2X3' })).toThrow(/#5.*IfcPropertyBoundedValue.*WR22/);
        expect(merge).toThrow(/#5.*IfcPropertyBoundedValue.*WR22/);
        return;
      }
      const result = exporter.export({ schema: 'IFC2X3' });
      expect(new TextDecoder().decode(result.content)).toContain(row.expect);
      expect(new TextDecoder().decode(merge().content)).toContain(row.expect);
      const losses = result.stats.warnings.filter(w => w.includes('IFCPROPERTYBOUNDEDVALUE.'));
      if (row.dropped) expect(losses).toEqual([expect.stringContaining(row.dropped)]);
      else expect(losses).toEqual([]);
    });
  }
});
