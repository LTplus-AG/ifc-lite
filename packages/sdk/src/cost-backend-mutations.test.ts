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
 */

import { describe, expect, it } from 'vitest';
import { IfcParser, type CostMutationOverlay, type IfcDataStore } from '@ifc-lite/parser';
import { createCostBackend } from './cost-backend.js';

const STEP = [
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
].join('\n');

async function parsedStore(): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(STEP);
  return new IfcParser().parseColumnar(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    { disableWorkerScan: true },
  );
}

/** A pending rename of the nested "Facade material" item. */
const RENAME: CostMutationOverlay = {
  getAttributeMutationsForEntity: id =>
    id === 42 ? [{ name: 'Name', value: 'Facade material (revised)' }] : [],
};

/** A pending deletion of the labour cost value #31 that item #43 still lists. */
const DELETE_VALUE: CostMutationOverlay = { isDeleted: id => id === 31 };

function itemNames(items: ReadonlyArray<{ Name?: string }>): (string | undefined)[] {
  return items.map(item => item.Name);
}

describe('bim.cost observes pending loaded-model mutations (#4857)', () => {
  it('reports the pending name by default and the on-disk name under includeMutations:false', async () => {
    const store = await parsedStore();
    const cost = createCostBackend(() => ({ modelId: 'm', store, overlay: RENAME }));

    expect(itemNames(cost.items())).toContain('Facade material (revised)');
    expect(itemNames(cost.items())).not.toContain('Facade material');

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
    const store = await parsedStore();
    const cost = createCostBackend(() => ({ modelId: 'm', store, overlay: RENAME }));

    // Overlaid read FIRST. If the overlaid graph were written into the
    // unmutated-graph cache, the on-disk read that follows would serve it.
    expect(itemNames(cost.items())).toContain('Facade material (revised)');
    expect(itemNames(cost.items(undefined, { includeMutations: false }))).toContain('Facade material');
    // …and back again, proving neither read cached over the other.
    expect(itemNames(cost.items())).toContain('Facade material (revised)');
    expect(itemNames(cost.items(undefined, { includeMutations: false }))).toContain('Facade material');
  });

  it('a later edit is visible to the next read — no stale cached graph', async () => {
    const store = await parsedStore();
    // The resolver hands back whatever the session's overlay currently is,
    // exactly as the viewer adapter does; edits arrive between reads.
    const pending = new Map<number, string>();
    const cost = createCostBackend(() => ({
      modelId: 'm',
      store,
      overlay: {
        getAttributeMutationsForEntity: id => {
          const value = pending.get(id);
          return value === undefined ? [] : [{ name: 'Name', value }];
        },
      },
    }));

    expect(itemNames(cost.items())).toContain('Facade material');
    pending.set(42, 'Renamed once');
    expect(itemNames(cost.items())).toContain('Renamed once');
    pending.set(42, 'Renamed twice');
    expect(itemNames(cost.items())).toContain('Renamed twice');
    expect(itemNames(cost.items())).not.toContain('Renamed once');
  });

  it('an evaluation observes the pending edit too, not just the listing', async () => {
    const store = await parsedStore();
    const cost = createCostBackend(() => ({ modelId: 'm', store, overlay: DELETE_VALUE }));

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

  it('a host with no overlay reads exactly as it did before', async () => {
    const store = await parsedStore();
    const withoutOverlay = createCostBackend(() => ({ modelId: 'm', store }));
    const explicitlyUnmutated = createCostBackend(() => ({ modelId: 'm', store, overlay: RENAME }))
      .data(undefined, { includeMutations: false });
    expect(JSON.stringify(withoutOverlay.data())).toBe(JSON.stringify(explicitlyUnmutated));
  });
});
