/* SPDX-License-Identifier: MPL-2.0 */

import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { classifyEntityTypeConversion } from './schema-conversion-loss-report.js';
import { StepExporter } from './step-exporter.js';

async function upgrade(fixture: string): Promise<string> {
  const raw = readFileSync(new URL(`../../../rust/export/tests/fixtures/${fixture}`, import.meta.url));
  const store = await new IfcParser().parseColumnar(Uint8Array.from(raw).buffer);
  const result = new StepExporter(store).export({ schema: 'IFC4X3' });
  return new TextDecoder().decode(result.content);
}

it('upgrades IFC4 styles, proxies, and standard cases to declared IFC4X3 entities (#10971)', async () => {
  const out = await upgrade('schema_ifc4x3_deleted_types.ifc');
  expect(out).toContain("#1=IFCDOORTYPE('0YvctVUKr0kugbFTf53O9L',$,'Door Style',$,$,$,$,'D-1',$,.NOTDEFINED.,.SINGLE_SWING_LEFT.,.T.,$);");
  expect(out).toContain("#2=IFCWINDOWTYPE('0YvctVUKr0kugbFTf53O9A',$,'Window Style',$,$,$,$,'W-1',$,.NOTDEFINED.,.DOUBLE_PANEL_VERTICAL.,.F.,$);");
  expect(out).toContain("#3=IFCBUILDINGELEMENTPROXY('0YvctVUKr0kugbFTf53O9B',$,'Proxy',$,'Proxy object',$,$,'PX-1',.NOTDEFINED.);");
  expect(classifyEntityTypeConversion('IFCWINDOWSTYLE', 'IFC4', 'IFC4X3').droppedAttributes)
    .toEqual(['ConstructionType', 'Sizeable']);
  expect(out).toContain("#4=IFCWALL('0YvctVUKr0kugbFTf53O9C',$,'Wall',$,$,$,$,$,.NOTDEFINED.);");
});

it('omits IFC2X3 resources and rewrites their IFC4X3 referrers (#10971)', async () => {
  const out = await upgrade('schema_unrooted_upgrade.ifc');
  expect(out).not.toMatch(/^#(?:3|6|7|19|21)=/m);
  expect(out).toContain('#4=IFCGEOMETRICCURVESET((#5));');
  expect(out).toContain("#12=IFCSTYLEDITEM($,(#10),'keep #3 as text');");
});
