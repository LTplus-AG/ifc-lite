// SPDX-License-Identifier: MPL-2.0

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { StepExporter } from './step-exporter.js';

async function exportRetyped(bytes: ArrayBuffer, retypes: Array<{ entityId: number; entityType: string }>) {
  const store = await new IfcParser().parseColumnar(bytes, { disableWorkerScan: true });
  const view = new MutablePropertyView(null, 'model');
  view.importMutations(JSON.stringify({ mutations: retypes.map(retype => ({ type: 'UPDATE_ENTITY_TYPE', ...retype })) }));
  const result = new StepExporter(store, view).export({ schema: 'IFC4' });
  return { lines: new TextDecoder().decode(result.content).split('\n'), warnings: result.stats.warnings };
}

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
  const { lines, warnings } = await exportRetyped(new TextEncoder().encode(source).buffer, [{ entityId: 1, entityType }]);
  return { lines, relation: lines.find(line => line.startsWith('#4=')), warnings };
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
  it('detaches the wall and door types in the authored door fixture', async (context) => {
    const fixture = new URL('../../../tests/models/various/issue-604-door.ifc', import.meta.url);
    if (!existsSync(fixture)) {
      context.skip('Run pnpm fixtures to fetch various/issue-604-door.ifc.');
      return;
    }
    const { lines, warnings } = await exportRetyped(Uint8Array.from(readFileSync(fixture)).buffer, [
      { entityId: 55, entityType: 'IfcSlab' },
      { entityId: 2390, entityType: 'IfcWindow' },
    ]);
    for (const prefix of ['#55=IFCSLAB(', '#2390=IFCWINDOW(', '#73=IFCWALLTYPE(', '#2333=IFCDOORTYPE(']) {
      expect(lines.some(line => line.startsWith(prefix))).toBe(true);
    }
    for (const id of [2424, 2425]) {
      expect(lines.some(line => line.startsWith(`#${id}=IFCRELDEFINESBYTYPE(`))).toBe(false);
      expect(warnings.some(warning => warning.includes(`Relationship #${id} (IFCRELDEFINESBYTYPE) lost its type assignment`))).toBe(true);
    }
  });
});
