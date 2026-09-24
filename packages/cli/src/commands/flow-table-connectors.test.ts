/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * End-to-end pilot workflow (issue #5167 phase 3.2): `ReadCsv → JoinByKey →
 * ApplyTable`, run headlessly through `ifc-lite flow run` against a real
 * model with a duplicate match value, exercising the ONE thing a unit test
 * over a fake backend cannot: `table.joinByKey`'s reused
 * `@ifc-lite/mutations` `csv-match.ts` index builder running through the
 * CLI's real `HeadlessBackend.tableAccess()` (see `host.ts`'s `TableAccess`,
 * wired in `loader.ts`/`flow.ts`), and `model.applyTable` writing through the
 * real `MutablePropertyView` overlay so the written `PropertyValueType` can
 * be read back, not just the raw value.
 *
 * Uses the `property` match strategy (`Pset_Fabrication.Mark`), not `tag`:
 * `@ifc-lite/parser`'s columnar parser — what `ifc-lite flow run` loads a
 * model through — does not populate `EntityTable.getTag` at all (it is
 * documented as "server-parsed stores only", issue #1765), so a `Tag`
 * attribute written directly in STEP is invisible to `resolveTag` in this
 * CLI path regardless of `table.joinByKey`'s own code. `property` exercises
 * the exact same reused `buildMatchContext`/`matchRowAgainstContext`
 * functions and the same ambiguity handling over data the columnar parser
 * DOES extract (ordinary property sets) — the `tag` strategy's own dedicated
 * coverage (that it is reachable and reports plainly when a host cannot
 * support it) lives in `packages/flow-nodes/src/nodes.test.ts`.
 */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PropertyValueType } from '@ifc-lite/data';
import { findPropertyInSets } from '@ifc-lite/query';
import { flowCommand } from './flow.js';
import { createHeadlessContext } from '../loader.js';

function capture() {
  const out: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out.push(String(chunk)); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  return { json: () => JSON.parse(out.join('')) as Record<string, unknown> };
}

afterEach(() => vi.restoreAllMocks());

/** Three walls, each carrying a `Pset_Fabrication.Mark` property: W1 and W2
 *  share "T-100" (the duplicate case), W3 carries the unique "T-200". No
 *  placement/representation — this workflow only touches properties. */
const MODEL_STEP = [
  'ISO-10303-21;',
  'HEADER;',
  "FILE_DESCRIPTION((''),'2;1');",
  "FILE_NAME('t.ifc','',(''),(''),'','','');",
  "FILE_SCHEMA(('IFC4'));",
  'ENDSEC;',
  'DATA;',
  "#1=IFCPROJECT('0project000000000000001',$,'P',$,$,$,$,$,$);",
  "#10=IFCWALL('0wall000000000000000w1',$,'Wall 1',$,$,$,$,$,$);",
  "#11=IFCWALL('0wall000000000000000w2',$,'Wall 2',$,$,$,$,$,$);",
  "#12=IFCWALL('0wall000000000000000w3',$,'Wall 3',$,$,$,$,$,$);",
  "#100=IFCPROPERTYSINGLEVALUE('Mark',$,IFCLABEL('T-100'),$);",
  "#101=IFCPROPERTYSET('0pset0000000000000pw01',$,'Pset_Fabrication',$,(#100));",
  "#102=IFCRELDEFINESBYPROPERTIES('0rel00000000000000rw01',$,$,$,(#10),#101);",
  "#110=IFCPROPERTYSINGLEVALUE('Mark',$,IFCLABEL('T-100'),$);",
  "#111=IFCPROPERTYSET('0pset0000000000000pw02',$,'Pset_Fabrication',$,(#110));",
  "#112=IFCRELDEFINESBYPROPERTIES('0rel00000000000000rw02',$,$,$,(#11),#111);",
  "#120=IFCPROPERTYSINGLEVALUE('Mark',$,IFCLABEL('T-200'),$);",
  "#121=IFCPROPERTYSET('0pset0000000000000pw03',$,'Pset_Fabrication',$,(#120));",
  "#122=IFCRELDEFINESBYPROPERTIES('0rel00000000000000rw03',$,$,$,(#12),#121);",
  'ENDSEC;',
  'END-ISO-10303-21;',
].join('\n');

/** ReadCsv → JoinByKey(property) → ApplyTable. Row "T-999" is deliberately
 *  unmatched, and "T-100" is deliberately ambiguous (two walls share it) —
 *  only the "T-200" row should reach ApplyTable and write. */
function flowGraph() {
  return {
    flowVersion: 1,
    id: 'csv-property-apply',
    name: 'CSV property apply',
    capabilities: ['model.read', 'model.mutate:Pset_WallCommon'],
    inputs: [],
    outputs: [
      { nodeId: 'apply', port: 'entities', label: 'Applied' },
      { nodeId: 'apply', port: 'problems', label: 'Apply problems' },
      { nodeId: 'join', port: 'unmatched', label: 'Unmatched' },
      { nodeId: 'join', port: 'ambiguous', label: 'Ambiguous' },
    ],
    nodes: [
      { id: 'csv', type: 'core.string', params: { value: 'Mark,FireRating\nT-100,REI30\nT-200,REI90\nT-999,REI60\n' } },
      { id: 'read', type: 'table.readCsv', params: { columns: [{ name: 'Mark', type: 'string' }, { name: 'FireRating', type: 'string' }] } },
      { id: 'walls', type: 'model.byType', params: { type: 'IfcWall' } },
      { id: 'join', type: 'table.joinByKey', params: { strategy: 'property', column: 'Mark', pset: 'Pset_Fabrication', prop: 'Mark' } },
      { id: 'apply', type: 'model.applyTable', params: { mapping: [{ column: 'FireRating', pset: 'Pset_WallCommon', prop: 'FireRating' }] } },
    ],
    edges: [
      { from: ['csv', 'value'], to: ['read', 'text'] },
      { from: ['walls', 'entities'], to: ['join', 'entities'] },
      { from: ['read', 'table'], to: ['join', 'table'] },
      { from: ['join', 'matched'], to: ['apply', 'table'] },
    ],
  };
}

describe('flow run: CSV → JoinByKey(property) → ApplyTable pilot workflow (#5167 phase 3.2)', () => {
  it('matches the unique mark, separates the duplicate mark and the unknown mark, and writes back a typed property', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ifc-flow-tables-'));
    const modelPath = join(dir, 'model.ifc');
    const graphPath = join(dir, 'graph.flow.json');
    await writeFile(modelPath, MODEL_STEP);
    await writeFile(graphPath, JSON.stringify(flowGraph()));

    const outPath = join(dir, 'out.ifc');
    const c = capture();
    await flowCommand(['run', graphPath, modelPath, '--out', outPath, '--json']);
    const summary = c.json() as unknown as { ok: boolean; outputs: Array<{ label: string; data: unknown }> };
    expect(summary.ok).toBe(true);
    const applied = summary.outputs.find((o) => o.label === 'Applied')?.data as { kind: string; items: Array<{ globalId: string }> };
    const applyProblems = summary.outputs.find((o) => o.label === 'Apply problems')?.data as { kind: string; items: string[] };
    const unmatched = summary.outputs.find((o) => o.label === 'Unmatched')?.data as { kind: string; value: { rows: Array<Record<string, unknown>> } };
    const ambiguous = summary.outputs.find((o) => o.label === 'Ambiguous')?.data as { kind: string; value: { rows: Array<Record<string, unknown>> } };

    // Only the unique mark "T-200" (wall W3) reaches ApplyTable.
    expect(applied.items).toEqual([{ globalId: '0wall000000000000000w3' }]);
    expect(applyProblems.items).toEqual([]);

    // "T-999" matches no wall's Mark.
    expect(unmatched.value.rows).toEqual([{ Mark: 'T-999', FireRating: 'REI60' }]);

    // "T-100" is claimed by TWO walls (W1, W2) — reported, not resolved to
    // either one silently.
    expect(ambiguous.value.rows).toHaveLength(1);
    const ambiguousIds = String(ambiguous.value.rows[0].MatchedGlobalIds).split(';').sort();
    expect(ambiguousIds).toEqual(['0wall000000000000000w1', '0wall000000000000000w2']);

    // Read the write back through a FRESH headless context (not the run's own
    // in-memory state) and confirm the property's declared PropertyValueType,
    // not just its raw string value.
    const { bim } = await createHeadlessContext(outPath);
    const w3 = bim.query().byType('IfcWall').toArray().find((e) => e.name === 'Wall 3')!;
    const prop = findPropertyInSets(bim.properties(w3.ref), 'Pset_WallCommon', 'FireRating');
    expect(prop?.value).toBe('REI90');
    expect(prop?.type).toBe(PropertyValueType.String);

    // W1/W2 (the ambiguous mark) must NOT have been written.
    const w1 = bim.query().byType('IfcWall').toArray().find((e) => e.name === 'Wall 1')!;
    expect(findPropertyInSets(bim.properties(w1.ref), 'Pset_WallCommon', 'FireRating')).toBeUndefined();
  });
});
