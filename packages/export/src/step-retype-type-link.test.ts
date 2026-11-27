// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { StepExporter } from './step-exporter.js';

async function exportRetype(members: string, entityType: string) {
  const source = `ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCWALL('3nZ2y9nY9FExK3Wg9nLvXz',$,'Wall A',$,$,$,$,$,.STANDARD.);
#2=IFCWALL('0uK8j9R5T5E8Gf7Ybq5ZpA',$,'Wall B',$,$,$,$,$,.STANDARD.);
#3=IFCWALLTYPE('0YvctVUKr0kugbFTf53O9L',$,'Wall Type',$,$,$,$,$,$,.STANDARD.);
#4=IFCRELDEFINESBYTYPE('2VQ9wAx1j4Bh3OB5NYQuhQ',$,$,$,(${members}),#3);
ENDSEC;
END-ISO-10303-21;
`;
  const bytes = new TextEncoder().encode(source);
  const store = await new IfcParser().parseColumnar(bytes.buffer, { disableWorkerScan: true });
  const view = new MutablePropertyView(null, 'model');
  view.importMutations(JSON.stringify({
    mutations: [{ type: 'UPDATE_ENTITY_TYPE', entityId: 1, entityType }],
  }));
  const result = new StepExporter(store, view).export({ schema: 'IFC4' });
  const lines = new TextDecoder().decode(result.content).split('\n');
  return { lines, relation: lines.find(line => line.startsWith('#4=')), warnings: result.stats.warnings };
}

describe('STEP type-assignment retyping #11500', () => {
  it('keeps the other typed wall in a mixed relationship', async () => {
    const { lines, relation, warnings } = await exportRetype('#1,#2', 'IfcSlab');
    expect(lines.some(line => line.startsWith('#1=IFCSLAB('))).toBe(true);
    expect(relation).toMatch(/\(#2\),#3\);$/);
    expect(warnings.join('\n')).toContain('Relationship #4 (IFCRELDEFINESBYTYPE) lost its type assignment to #3 for #1');
  });

  it('withholds and reports a relationship with no valid members left', async () => {
    const { lines, relation, warnings } = await exportRetype('#1', 'IfcSlab');
    expect(lines.some(line => line.startsWith('#3=IFCWALLTYPE('))).toBe(true);
    expect(relation).toBeUndefined();
    expect(warnings.join('\n')).toContain('The empty relationship was withheld.');
  });

  it('retains an assignment to a valid parent type', async () => {
    const { lines, relation, warnings } = await exportRetype('#1', 'IfcWallStandardCase');
    expect(lines.some(line => line.startsWith('#1=IFCWALLSTANDARDCASE('))).toBe(true);
    expect(relation).toMatch(/\(#1\),#3\);$/);
    expect(warnings.join('\n')).not.toContain('lost its type assignment');
  });
});
