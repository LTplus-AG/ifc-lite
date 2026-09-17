/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #4857 — `bim.cost` reads observe a loaded model's PENDING edits, and
 * `includeMutations: false` means the file on disk rather than an empty graph.
 *
 * The fixture is a real STEP file parsed by `IfcParser`, nesting two priced
 * cost items under a parent, controlling them from a schedule, assigning one
 * to a wall, and pricing them in CHF at non-round rates against a UnitBasis.
 * The evaluation assertions below are what make it load-bearing: a single
 * unnested cost item would evaluate identically no matter what the overlay
 * did to the rest of the graph.
 *
 * Edits go through a real `MutablePropertyView`, and wherever the edit is
 * written to the file the oracle is the file itself: the same view is
 * exported with `StepExporter`, the bytes are re-parsed, and the cost graph
 * read from them must equal the pending read.
 */

import { describe, expect, it } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { createCostBackend } from './cost-backend.js';
import type { CostGraphData } from './cost-types.js';

const STEP_LINES = [
  "ISO-10303-21;",
  "HEADER;",
  "FILE_DESCRIPTION((''),'2;1');",
  "FILE_NAME('cost.ifc','2026-01-01T00:00:00',(''),(''),'','','');",
  "FILE_SCHEMA(('IFC4'));",
  "ENDSEC;",
  "DATA;",
  "#1=IFCWALL('0wall00000000000000001',$,'Exterior wall',$,$,$,$,$,$);",
  "#10=IFCMONETARYUNIT('CHF');",
  "#11=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);",
  "#12=IFCMEASUREWITHUNIT(IFCAREAMEASURE(1.),#11);",
  "#13=IFCUNITASSIGNMENT((#10,#11));",
  "#14=IFCPROJECT('0proj00000000000000001',$,'Project',$,$,$,$,$,#13);",
  "#20=IFCQUANTITYAREA('NetArea',$,#11,12.5,$);",
  "#21=IFCQUANTITYAREA('NetArea',$,#11,4.25,$);",
  "#30=IFCCOSTVALUE('Unit rate',$,IFCMONETARYMEASURE(87.45),#12,$,$,'Material',$,$,$);",
  "#31=IFCCOSTVALUE('Labour rate',$,IFCMONETARYMEASURE(12.05),#12,$,$,'Labour',$,$,$);",
  "#40=IFCCOSTSCHEDULE('0sched0000000000000001',$,'Tender schedule',$,$,'CS-1',.TENDER.,'Issued',$,$);",
  "#41=IFCCOSTITEM('0item00000000000000001',$,'Facade package',$,$,'A',.NOTDEFINED.,$,$);",
  "#42=IFCCOSTITEM('0item00000000000000002',$,'Facade material',$,$,'A.1',.NOTDEFINED.,(#30),(#20));",
  "#43=IFCCOSTITEM('0item00000000000000003',$,'Facade labour',$,$,'A.2',.NOTDEFINED.,(#31),(#21));",
  "#50=IFCRELNESTS('0nest00000000000000001',$,$,$,#41,(#42,#43));",
  "#51=IFCRELASSIGNSTOCONTROL('0ctrl00000000000000001',$,$,$,(#41),$,#40);",
  "#52=IFCRELASSIGNSTOPRODUCT('0prod00000000000000001',$,$,$,(#42),$,#1);",
  "ENDSEC;",
  "END-ISO-10303-21;",
];

async function parse(text: string): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(text);
  return new IfcParser().parseColumnar(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    { disableWorkerScan: true },
  );
}

/** The fixture, with optional extra DATA records spliced in before the closing ENDSEC. */
function stepWith(extra: string[] = []): string {
  const dataEnd = STEP_LINES.lastIndexOf('ENDSEC;');
  return [...STEP_LINES.slice(0, dataEnd), ...extra, ...STEP_LINES.slice(dataEnd)].join('\n');
}

/**
 * A loaded model with a real `MutablePropertyView`, read through `bim.cost`,
 * plus the oracle: the same view exported and the cost graph re-read from the
 * exported bytes.
 */
async function session(edit: (view: MutablePropertyView) => void, extra: string[] = []) {
  const store = await parse(stepWith(extra));
  const view = new MutablePropertyView(null, 'm');
  edit(view);
  const cost = createCostBackend(() => ({ modelId: 'm', store, mutationView: view }));
  const exportedGraph = async (): Promise<CostGraphData> => {
    const exported = new StepExporter(store, view).export({ schema: store.schemaVersion, applyMutations: true });
    const reparsed = await parse(new TextDecoder().decode(exported.content));
    return createCostBackend(() => ({ modelId: 'm', store: reparsed })).data();
  };
  return { store, view, cost, exportedGraph };
}

function itemNames(items: ReadonlyArray<{ Name?: string }>): (string | undefined)[] {
  return items.map(item => item.Name);
}

function valueById(graph: CostGraphData, expressId: number) {
  return graph.CostValues.find(value => value.ref.expressId === expressId);
}

describe('bim.cost observes pending loaded-model mutations (#4857)', () => {
  it('reports the pending name by default and the on-disk name under includeMutations:false', async () => {
    const { cost, exportedGraph } = await session(view => view.setAttribute(42, 'Name', 'Facade material (revised)'));

    expect(itemNames(cost.items())).toContain('Facade material (revised)');
    expect(itemNames(cost.items())).not.toContain('Facade material');
    expect(cost.data()).toEqual(await exportedGraph());

    const onDisk = cost.items(undefined, { includeMutations: false });
    expect(itemNames(onDisk)).toContain('Facade material');
    expect(itemNames(onDisk)).not.toContain('Facade material (revised)');
    // includeMutations:false is the file on disk — NOT an empty cost graph.
    expect(onDisk).toHaveLength(3);
    const onDiskGraph = cost.data(undefined, { includeMutations: false });
    expect(onDiskGraph.HasCostData).toBe(true);
    expect(onDiskGraph.CostValues).toHaveLength(2);
    expect(onDiskGraph.CostSchedules).toHaveLength(1);
  });

  it('never poisons the on-disk cache with an overlaid read, in either order', async () => {
    const { cost } = await session(view => view.setAttribute(42, 'Name', 'Facade material (revised)'));

    // Overlaid read FIRST. If the overlaid graph were written into the
    // unmutated-graph cache, the on-disk read that follows would serve it.
    expect(itemNames(cost.items())).toContain('Facade material (revised)');
    expect(itemNames(cost.items(undefined, { includeMutations: false }))).toContain('Facade material');
    // …and back again, proving neither read cached over the other.
    expect(itemNames(cost.items())).toContain('Facade material (revised)');
    expect(itemNames(cost.items(undefined, { includeMutations: false }))).toContain('Facade material');
  });

  it('a later edit is visible to the next read — no stale cached graph', async () => {
    const { cost, view } = await session(() => {});

    expect(itemNames(cost.items())).toContain('Facade material');
    view.setAttribute(42, 'Name', 'Renamed once');
    expect(itemNames(cost.items())).toContain('Renamed once');
    view.setAttribute(42, 'Name', 'Renamed twice');
    expect(itemNames(cost.items())).toContain('Renamed twice');
    expect(itemNames(cost.items())).not.toContain('Renamed once');
  });

  it('an evaluation observes the pending edit too, not just the listing', async () => {
    const { cost } = await session(view => { view.deleteEntity(31); });

    // On disk: 4.25 m2 at 12.05 CHF/m2.
    const onDisk = cost.evaluateItem({ modelId: 'm', expressId: 43 }, { includeMutations: false });
    expect(onDisk.Amount).toBe('51.2125');
    expect(onDisk.Currency).toBe('CHF');

    // With the rate deleted there is no priced value left to evaluate, and the
    // result says so rather than quietly reporting the pre-delete amount.
    const pendingResult = cost.evaluateItem({ modelId: 'm', expressId: 43 });
    expect(pendingResult.Amount).not.toBe('51.2125');
    expect(pendingResult.Diagnostics.length).toBeGreaterThan(0);

    // The sibling item the deletion does not touch is unchanged in both reads.
    expect(cost.evaluateItem({ modelId: 'm', expressId: 42 }).Amount).toBe('1093.125');
    expect(cost.evaluateItem({ modelId: 'm', expressId: 42 }, { includeMutations: false }).Amount)
      .toBe('1093.125');
  });

  it('a host with no mutation view reads exactly as it did before', async () => {
    const { store, cost } = await session(view => view.setAttribute(42, 'Name', 'Facade material (revised)'));
    const withoutView = createCostBackend(() => ({ modelId: 'm', store }));
    expect(JSON.stringify(withoutView.data()))
      .toBe(JSON.stringify(cost.data(undefined, { includeMutations: false })));
  });

  // Carried over from the parser suite, now against the exporter as oracle.
  it('a quoted label and an empty label read as the exporter writes them', async () => {
    const { cost, exportedGraph } = await session(view => {
      view.setAttribute(30, 'Category', "Owner's supply");
      view.setAttribute(31, 'Condition', '');
    });
    expect(valueById(cost.data(), 30)?.Category).toBe("Owner's supply");
    // The exporter writes an empty edit to a string slot as `$` (`serializeStringSlot`),
    // so the read reports it absent too. Reporting PRESENT-and-empty here would be
    // a read the exported file contradicts.
    expect(valueById(cost.data(), 31)?.Condition).toBeUndefined();
    expect(valueById(cost.data(), 31)?.InvalidCondition).toBeUndefined();
    expect(cost.data()).toEqual(await exportedGraph());
  });

  // IFC2X3 puts IfcCostSchedule.Status at slot 8 and IFC4 at slot 7, so an edit
  // resolved against the wrong schema lands on SubmittedOn instead.
  it('an edit to an IFC2X3 record lands in the slot its own schema names', async () => {
    const store = await parse([
      ...STEP_LINES.slice(0, 4), "FILE_SCHEMA(('IFC2X3'));", 'ENDSEC;', 'DATA;',
      "#30=IFCCOSTSCHEDULE('sched-gid-000000000001',$,'Tender schedule',$,$,$,$,$,'Issued',$,$,'CS-1',.TENDER.);",
      "#40=IFCCOSTITEM('item-gid-0000000000001',$,'Facade package',$,$);",
      'ENDSEC;', 'END-ISO-10303-21;',
    ].join('\n'));
    const view = new MutablePropertyView(null, 'm');
    view.setAttribute(30, 'Status', 'Revised');
    const schedule = createCostBackend(() => ({ modelId: 'm', store, mutationView: view })).schedules()[0];
    expect(schedule).toMatchObject({ Status: 'Revised', ID: 'CS-1' });
    expect(schedule.SubmittedOn).toBeUndefined();
  });

  // The exporter writes an enum slot as `.ADD.`. Quoting every overlaid value
  // made the read model report no operator at all.
  it('an enum edit reads as the enum the exporter writes', async () => {
    const { cost, exportedGraph } = await session(view => view.setAttribute(30, 'ArithmeticOperator', 'ADD'));
    expect(valueById(cost.data(), 30)?.ArithmeticOperator).toBe('ADD');
    expect(cost.data()).toEqual(await exportedGraph());
  });

  // `setPositionalAttribute` edits never reached the named-edit contract.
  it('positional edits to AppliedValue and CostValues reach reads and evaluation', async () => {
    const { cost, exportedGraph } = await session(view => {
      view.setPositionalAttribute(30, 2, { typed: { type: 'IFCMONETARYMEASURE', value: 99.5 } });
      view.setPositionalAttribute(43, 7, ['#30']);
    });
    expect(valueById(cost.data(), 30)?.AppliedValue).toMatchObject({ Type: 'IFCMONETARYMEASURE', Value: '99.5' });
    // 12.5 m2 at the edited 99.5 CHF/m2.
    expect(cost.evaluateItem({ modelId: 'm', expressId: 42 }).Amount).toBe('1243.75');
    expect(cost.data().CostItems.find(item => item.ref.expressId === 43)?.CostValues)
      .toEqual([{ modelId: 'm', expressId: 30 }]);
    expect(cost.data()).toEqual(await exportedGraph());
  });

  it('a retype moves an entity out of and into the cost item listing', async () => {
    const { cost, exportedGraph } = await session(view => {
      view.setEntityType(43, 'IfcTask', null, 'IfcCostItem');
      view.setEntityType(1, 'IfcCostItem', null, 'IfcWall');
    });
    const ids = cost.items().map(item => item.ref.expressId);
    expect(ids).not.toContain(43);
    expect(ids).toContain(1);
    expect(cost.data()).toEqual(await exportedGraph());
  });

  // The exporter never grows a source record: an edit to a slot past the end
  // of a truncated record is skipped, so the read must not report it either.
  it('an edit past the end of a truncated record is not reported', async () => {
    const { cost, exportedGraph } = await session(
      view => view.setAttribute(44, 'Identification', 'A.3'),
      ["#44=IFCCOSTITEM('0item00000000000000004',$,'Short item');"],
    );
    expect(cost.data().CostItems.find(item => item.ref.expressId === 44)?.Identification).toBeUndefined();
    expect(cost.data()).toEqual(await exportedGraph());
  });

  it('an edit the exporter refuses to write is reported, not passed off as current', async () => {
    const { cost } = await session(view => view.setAttribute(20, 'AreaValue', 'twelve'));
    const refused = cost.data().Diagnostics.filter(diagnostic => diagnostic.Code === 'PENDING_EDIT_NOT_APPLIED');
    expect(refused).toHaveLength(1);
    expect(refused[0].ref).toEqual({ modelId: 'm', expressId: 20 });
  });
});
