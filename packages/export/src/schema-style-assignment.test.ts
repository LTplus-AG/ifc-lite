/* SPDX-License-Identifier: MPL-2.0 */
import { readFileSync } from 'node:fs';
import { IfcParser } from '@ifc-lite/parser';
import { expect, it } from 'vitest';
import { MergedExporter } from './merged-exporter.js';
import { StepExporter } from './step-exporter.js';

it('wraps direct IFC4X3 styles in an IFC2X3 style assignment (#10879)', async () => {
  const input = readFileSync(new URL('../../../rust/export/tests/fixtures/schema_styled_item_downgrade.ifc', import.meta.url));
  const parser = new IfcParser();
  const store = await parser.parseColumnar(Uint8Array.from(input).buffer);
  const options = { schema: 'IFC2X3', projectStrategy: 'keep-first' } as const;
  const merged = new MergedExporter([{ id: 'm', name: 'Styled', dataStore: store }]);
  for (const result of [new StepExporter(store).export(options), merged.export(options), await merged.exportAsync(options)]) {
    const text = new TextDecoder().decode(result.content);
    const count = 'totalEntityCount' in result.stats ? result.stats.totalEntityCount : result.stats.entityCount;
    expect(count).toBe(text.match(/^#\d+=/gm)?.length);
    const id = /#(\d+)=IFCPRESENTATIONSTYLEASSIGNMENT\(\(\/\* style \*\/ #3 \/\* member \*\/\)\);/.exec(text)?.[1];
    expect(id).toBeDefined();
    expect(text).toContain("#2=IFCSTYLEDITEM(#1,(#" + id + "),'Styled point');");
    const edited = await parser.parseColumnar(Uint8Array.from(result.content).buffer);
    const roundTrip = new TextDecoder().decode(new StepExporter(edited).export(options).content);
    expect(roundTrip.match(/=IFCPRESENTATIONSTYLEASSIGNMENT\(/g)).toHaveLength(1);
  }
});
