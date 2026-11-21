/* SPDX-License-Identifier: MPL-2.0 */

import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { MergedExporter } from './merged-exporter.js';
import { analyzeConversionLoss } from './schema-conversion-loss-report.js';
import { StepExporter } from './step-exporter.js';

it('prunes references to removed IFC2X3 resources using IFC4 slot cardinality (#10970)', async () => {
  const raw = readFileSync(new URL('../../../rust/export/tests/fixtures/schema_unrooted_upgrade.ifc', import.meta.url));
  const store = await new IfcParser().parseColumnar(Uint8Array.from(raw).buffer);
  const single = new StepExporter(store).export({ schema: 'IFC4' });
  const merged = new MergedExporter([{ id: 'source', name: 'source', dataStore: store }]);
  const options = { schema: 'IFC4', projectStrategy: 'keep-first' } as const;
  for (const result of [single, merged.export(options), await merged.exportAsync(options)]) {
    const out = new TextDecoder().decode(result.content);
    expect(out).not.toMatch(/^#(?:3|6|7|19|21|22)=/m);
    expect(out).toContain('#4=IFCGEOMETRICCURVESET((#5));');
    expect(out).toContain('#13=IFCGEOMETRICCURVESET((#5));');
    expect(out).toContain("#12=IFCSTYLEDITEM($,(#11),'keep #3 as text');");
    expect(out).toContain('#17=IFCCURVEBOUNDEDPLANE(#16,#5,());');
    expect(result.stats.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('#3 (IFCBEZIERCURVE) was omitted'),
      expect.stringContaining('#21 (IFCCOMPOSITEPROFILEDEF) was omitted'),
      expect.stringContaining('#22 (IFCRELAXATION) was omitted'), // #11131
    ]));
  }
  const report = analyzeConversionLoss(store, 'IFC2X3', 'IFC4');
  expect(report.describe()).toContain('1 × IFCBEZIERCURVE (#3) will be omitted because IFC4 does not declare its type.');
  expect(report.describe()).toContain('1 × IFCRELAXATION (#22) will be omitted because IFC4 does not declare its type.');
});
