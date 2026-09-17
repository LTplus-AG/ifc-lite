/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #4857 — the cost read model reads THROUGH a loaded model's pending edits.
 *
 * The fixture is deliberately not a single flat cost item: it nests two cost
 * items under a parent, controls them from a schedule, assigns one to a
 * product, prices them in a non-default currency (CHF) against a
 * non-round rate with a UnitBasis, and composes a total from two components.
 * A flatter fixture would pass these assertions with most of the projection
 * missing.
 */

import { describe, it, expect } from 'vitest';
import { extractCostOnDemand } from '../src/cost-extractor.js';
import type { CostMutationOverlay } from '../src/cost-overlay.js';
import type { IfcDataStore } from '../src/columnar-parser.js';
import type { EntityRef } from '../src/types.js';

function buildStoreFromStep(
  lines: string[],
  schemaVersion: IfcDataStore['schemaVersion'] = 'IFC4',
): IfcDataStore {
  const text = lines.join('\n');
  const source = new TextEncoder().encode(text);
  const byId = new Map<number, EntityRef>();
  const byType = new Map<string, number[]>();
  let cursor = 0;
  for (const line of lines) {
    const match = line.match(/^#(\d+)\s*=\s*(\w+)\(/);
    if (!match) continue;
    const expressId = parseInt(match[1], 10);
    const type = match[2];
    const idx = text.indexOf(line, cursor);
    const byteOffset = idx >= 0 ? idx : cursor;
    byId.set(expressId, { expressId, type, byteOffset, byteLength: line.length, lineNumber: 1 });
    const typeUpper = type.toUpperCase();
    const list = byType.get(typeUpper) ?? [];
    list.push(expressId);
    byType.set(typeUpper, list);
    cursor = byteOffset + line.length + 1;
  }
  return {
    source,
    schemaVersion,
    entityIndex: { byId, byType },
    entities: { getGlobalId: () => '', getName: (id: number) => `entity${id}` },
  } as unknown as IfcDataStore;
}

/**
 * Two nested cost items under a parent, controlled by a schedule, one of them
 * assigned to a wall, priced in CHF at 87.45/m2 with a UnitBasis, plus a
 * composed total.
 */
const FIXTURE = [
  "#1=IFCWALL('wall-gid-0000000000001',$,'Exterior wall',$,$,$,$,$,$);",
  "#10=IFCMONETARYUNIT('CHF');",
  "#11=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);",
  "#12=IFCMEASUREWITHUNIT(IFCAREAMEASURE(1.),#11);",
  // Rate: 87.45 CHF per m2, and a second component priced at 12.05.
  "#20=IFCCOSTVALUE('Unit rate',$,IFCMONETARYMEASURE(87.45),#12,$,$,'Material',$,$,$);",
  "#21=IFCCOSTVALUE('Labour rate',$,IFCMONETARYMEASURE(12.05),#12,$,$,'Labour',$,$,$);",
  "#22=IFCCOSTVALUE('Composed total',$,$,$,$,$,'Total',$,.ADD.,(#20,#21));",
  "#23=IFCCOSTVALUE('Measured rate',$,#12,$,$,$,'Measured',$,$,$);",
  "#30=IFCCOSTSCHEDULE('sched-gid-000000000001',$,'Tender schedule',$,$,'CS-1',.TENDER.,'Issued',$,$);",
  "#40=IFCCOSTITEM('item-gid-0000000000001',$,'Facade package',$,$,'A',.NOTDEFINED.,(#22),$);",
  "#41=IFCCOSTITEM('item-gid-0000000000002',$,'Facade material',$,$,'A.1',.NOTDEFINED.,(#20),$);",
  "#42=IFCCOSTITEM('item-gid-0000000000003',$,'Facade labour',$,$,'A.2',.NOTDEFINED.,(#21),$);",
  "#50=IFCRELNESTS('nest-gid-0000000000001',$,$,$,#40,(#41,#42));",
  "#51=IFCRELASSIGNSTOCONTROL('ctrl-gid-0000000000001',$,$,$,(#40),$,#30);",
  "#52=IFCRELASSIGNSTOPRODUCT('prod-gid-0000000000001',$,$,$,(#41),$,#1);",
];

function overlay(parts: CostMutationOverlay): CostMutationOverlay { return parts; }

function itemById(graph: ReturnType<typeof extractCostOnDemand>, expressId: number) {
  return graph.CostItems.find(item => item.expressId === expressId);
}

describe('cost read model observes pending loaded-model mutations (#4857)', () => {
  it('reads the on-disk graph when no overlay is supplied', () => {
    const graph = extractCostOnDemand(buildStoreFromStep(FIXTURE));
    expect(graph.HasCostData).toBe(true);
    expect(itemById(graph, 41)?.Name).toBe('Facade material');
    expect(graph.Currency).toBeUndefined();
    // The fixture really does nest and assign — a flat fixture would not.
    expect(itemById(graph, 41)?.parentGlobalId).toBe('item-gid-0000000000001');
    expect(itemById(graph, 41)?.productExpressIds).toEqual([1]);
    expect(itemById(graph, 40)?.controllingScheduleGlobalIds).toEqual(['sched-gid-000000000001']);
  });

  it('a pending rename of a nested cost item is what the read model reports', () => {
    const graph = extractCostOnDemand(buildStoreFromStep(FIXTURE), {
      overlay: overlay({
        getAttributeMutationsForEntity: id =>
          id === 41 ? [{ name: 'Name', value: 'Facade material (revised)' }] : [],
      }),
    });
    expect(itemById(graph, 41)?.Name).toBe('Facade material (revised)');
    // The deprecated lower-cased mirror is derived from the same read, so it
    // cannot drift from the canonical field.
    expect(itemById(graph, 41)?.name).toBe('Facade material (revised)');
    // Nothing else moved.
    expect(itemById(graph, 42)?.Name).toBe('Facade labour');
    expect(itemById(graph, 41)?.parentGlobalId).toBe('item-gid-0000000000001');
  });

  it('resolves an edit to the slot its EXPRESS name names, not slot 2', () => {
    const graph = extractCostOnDemand(buildStoreFromStep(FIXTURE), {
      overlay: overlay({
        getAttributeMutationsForEntity: id =>
          id === 41 ? [{ name: 'Identification', value: 'A.1-rev2' }] : [],
      }),
    });
    expect(itemById(graph, 41)?.Identification).toBe('A.1-rev2');
    expect(itemById(graph, 41)?.Name).toBe('Facade material');
  });

  it('applies a pending edit to a cost value, including its lexeme-read Category', () => {
    const graph = extractCostOnDemand(buildStoreFromStep(FIXTURE), {
      overlay: overlay({
        getAttributeMutationsForEntity: id => id === 20
          ? [{ name: 'Name', value: 'Unit rate 2026' }, { name: 'Category', value: 'Material (imported)' }]
          : [],
      }),
    });
    const value = graph.CostValues.find(entry => entry.expressId === 20);
    expect(value?.Name).toBe('Unit rate 2026');
    expect(value?.Category).toBe('Material (imported)');
    // The amount is read from the lexeme, not the parsed attribute — an
    // untouched slot must survive the overlay's lexeme patching byte-exact.
    expect(value?.AppliedValue).toEqual({ Kind: 'Typed', Type: 'IFCMONETARYMEASURE', Value: '87.45' });
    expect(value?.UnitBasis).toBe(12);
  });

  it('escapes a quote in a pending edit rather than corrupting the record', () => {
    const graph = extractCostOnDemand(buildStoreFromStep(FIXTURE), {
      overlay: overlay({
        getAttributeMutationsForEntity: id =>
          id === 20 ? [{ name: 'Category', value: "Owner's supply" }] : [],
      }),
    });
    const value = graph.CostValues.find(entry => entry.expressId === 20);
    expect(value?.Category).toBe("Owner's supply");
    expect(value?.AppliedValue).toEqual({ Kind: 'Typed', Type: 'IFCMONETARYMEASURE', Value: '87.45' });
  });

  it('a pending edit naming no slot on the type is dropped, not misapplied', () => {
    const graph = extractCostOnDemand(buildStoreFromStep(FIXTURE), {
      overlay: overlay({
        getAttributeMutationsForEntity: id =>
          id === 41 ? [{ name: 'NotAnAttribute', value: 'nowhere' }] : [],
      }),
    });
    expect(itemById(graph, 41)?.Name).toBe('Facade material');
    expect(itemById(graph, 41)?.GlobalId).toBe('item-gid-0000000000002');
    expect(itemById(graph, 41)?.Identification).toBe('A.1');
  });

  it('a deleted cost item disappears from the graph and from its parent nest', () => {
    const graph = extractCostOnDemand(buildStoreFromStep(FIXTURE), {
      overlay: overlay({ isDeleted: id => id === 42 }),
    });
    expect(graph.CostItems.map(item => item.expressId)).toEqual([40, 41]);
    expect(itemById(graph, 40)?.childGlobalIds).toEqual(['item-gid-0000000000002']);
  });

  it('deleting a cost value an item still lists reports MISSING_REFERENCE, never a silent drop', () => {
    const graph = extractCostOnDemand(buildStoreFromStep(FIXTURE), {
      overlay: overlay({ isDeleted: id => id === 20 }),
    });
    const dangling = graph.Diagnostics.filter(
      diagnostic => diagnostic.Code === 'MISSING_REFERENCE' && diagnostic.RelatedExpressId === 20,
    );
    expect(dangling.length).toBeGreaterThan(0);
    expect(dangling.every(diagnostic => diagnostic.Severity === 'error')).toBe(true);
    // The item whose CostValues names it, and the composed total whose
    // Components name it, must BOTH be told.
    expect(new Set(dangling.map(diagnostic => diagnostic.expressId))).toEqual(new Set([41, 22]));
    // The canonical list still states what the file states; only the
    // compatibility view drops the unresolvable entry.
    expect(itemById(graph, 41)?.CostValues).toEqual([20]);
    expect(itemById(graph, 41)?.costValues).toEqual([]);
  });

  it('an empty-string edit is PRESENT-and-empty, not absent', () => {
    // `IfcCostValue.Condition` (slot 7) is `$` in the fixture, so the reader
    // reports neither a Condition nor `InvalidCondition`. Editing it to `''`
    // must make the slot PRESENT — which the reader distinguishes from absent
    // by raising `InvalidCondition` for a present-but-unreadable string. Had
    // the overlay collapsed `''` to `$`, this assertion would read the same
    // as the unedited baseline below and the distinction would be gone.
    const baseline = extractCostOnDemand(buildStoreFromStep(FIXTURE));
    expect(baseline.CostValues.find(entry => entry.expressId === 20)?.Condition).toBeUndefined();
    expect(baseline.CostValues.find(entry => entry.expressId === 20)?.InvalidCondition).toBeUndefined();

    const graph = extractCostOnDemand(buildStoreFromStep(FIXTURE), {
      overlay: overlay({
        getAttributeMutationsForEntity: id =>
          id === 20 ? [{ name: 'Condition', value: '' }] : [],
      }),
    });
    const value = graph.CostValues.find(entry => entry.expressId === 20);
    expect(value?.InvalidCondition).toBe(true);
    expect(value?.AppliedValue).toEqual({ Kind: 'Typed', Type: 'IFCMONETARYMEASURE', Value: '87.45' });
  });

  /**
   * IFC2X3 and IFC4 disagree about where `IfcCostSchedule.Status` lives —
   * slot 8 in IFC2X3, slot 7 in IFC4 — so an edit resolved against the
   * cross-schema union instead of the model's OWN schema lands one slot off,
   * on `SubmittedOn`. Nothing in an IFC4 fixture can catch that.
   */
  const FIXTURE_2X3 = [
    "#30=IFCCOSTSCHEDULE('sched-gid-000000000001',$,'Tender schedule',$,$,$,$,$,'Issued',$,$,'CS-1',.TENDER.);",
    "#40=IFCCOSTITEM('item-gid-0000000000001',$,'Facade package',$,$);",
  ];

  it('resolves an edit against the model own schema, not the cross-schema union', () => {
    const baseline = extractCostOnDemand(buildStoreFromStep(FIXTURE_2X3, 'IFC2X3'));
    expect(baseline.CostSchedules[0]).toMatchObject({ Status: 'Issued', ID: 'CS-1' });
    expect(baseline.CostSchedules[0].SubmittedOn).toBeUndefined();

    const graph = extractCostOnDemand(buildStoreFromStep(FIXTURE_2X3, 'IFC2X3'), {
      overlay: overlay({
        getAttributeMutationsForEntity: id =>
          id === 30 ? [{ name: 'Status', value: 'Revised' }] : [],
      }),
    });
    expect(graph.CostSchedules[0].Status).toBe('Revised');
    // The IFC4 slot for Status is IFC2X3's SubmittedOn — it must stay absent.
    expect(graph.CostSchedules[0].SubmittedOn).toBeUndefined();
    expect(graph.CostSchedules[0].ID).toBe('CS-1');
  });

  it('a deleted entity is unreachable through a reference, not only through ids()', () => {
    const baseline = extractCostOnDemand(buildStoreFromStep(FIXTURE));
    expect(baseline.CostValues.find(entry => entry.expressId === 23)?.AppliedValue)
      .toEqual({ Kind: 'Reference', expressId: 12 });

    // #23 is reached from `ids('IFCCOSTVALUE')`, so it survives; the
    // IfcMeasureWithUnit it POINTS AT is the thing deleted, and it is reached
    // only by `reader.get`. A tombstone honoured in `ids()` alone would leave
    // this reading as a live reference to an entity that will not be exported.
    const graph = extractCostOnDemand(buildStoreFromStep(FIXTURE), {
      overlay: overlay({ isDeleted: id => id === 12 }),
    });
    const value = graph.CostValues.find(entry => entry.expressId === 23);
    expect(value?.AppliedValue).not.toEqual({ Kind: 'Reference', expressId: 12 });
    expect(value?.AppliedValue?.Kind).toBe('Unsupported');
  });

  /**
   * `CostEntityReader.typeOf` guards on `isDeleted` before resolving a type —
   * `targetIs()` in cost-relationships.ts is the only thing that calls it,
   * and it backs `InvalidReferences` on every cost relationship. Without the
   * guard, a deleted relationship target still passes `targetIs()` (the STEP
   * line, and its type, are still on disk) and `InvalidReferences` never
   * flips, so the read model would keep reporting a relationship as valid
   * after its target was deleted through the overlay — the exact mismatch
   * between the read model and the exported file #4857 exists to fix.
   *
   * Both targets deleted here — #1 (IFCWALL) and #42 (IFCCOSTITEM) — are
   * valid targets for their relationship types WHEN PRESENT (the baseline
   * assertions below prove that), so a reader that ignored `isDeleted`
   * entirely, not just this one guard, would still pass a fixture where the
   * deleted id was never a legal target to begin with.
   */
  it('deleting a relationship target flips InvalidReferences, not just the target list', () => {
    const baseline = extractCostOnDemand(buildStoreFromStep(FIXTURE));
    const baselineProductRel = baseline.Relationships.find(
      rel => rel.Type === 'IfcRelAssignsToProduct' && rel.expressId === 52,
    );
    const baselineNestsRel = baseline.Relationships.find(
      rel => rel.Type === 'IfcRelNests' && rel.expressId === 50,
    );
    // Present and valid before either target is deleted — the wall (#1) and
    // the nested cost item (#42) are both legal targets for their
    // relationship type when they exist.
    expect(baselineProductRel?.RelatingProduct).toBe(1);
    expect(baselineProductRel?.InvalidReferences).toBeUndefined();
    expect(baselineNestsRel?.RelatedObjects).toContain(42);
    expect(baselineNestsRel?.InvalidReferences).toBeUndefined();

    // Delete the wall #52 assigns cost item #41 to, and the cost item #50
    // nests under #40 — two different relationship types, two different
    // reference shapes (a single RelatingProduct vs. a RelatedObjects list).
    const graph = extractCostOnDemand(buildStoreFromStep(FIXTURE), {
      overlay: overlay({ isDeleted: id => id === 1 || id === 42 }),
    });
    const productRel = graph.Relationships.find(
      rel => rel.Type === 'IfcRelAssignsToProduct' && rel.expressId === 52,
    );
    const nestsRel = graph.Relationships.find(
      rel => rel.Type === 'IfcRelNests' && rel.expressId === 50,
    );
    expect(productRel?.InvalidReferences).toBe(true);
    expect(nestsRel?.InvalidReferences).toBe(true);
    // The relationship's own record still names the deleted target — only
    // the validity flag changes, not a silent drop from the list.
    expect(productRel?.RelatingProduct).toBe(1);
    expect(nestsRel?.RelatedObjects).toContain(42);
  });

  /**
   * Resolved through a guarded dynamic import on purpose. A static value
   * import of a module the revert-oracle gate deletes turns a reverted run
   * into a LOAD failure, which the gate cannot attribute to an assertion;
   * degrading to a sentinel keeps the failure a value mismatch.
   */
  async function lexemeFor(value: string): Promise<string> {
    try {
      const module = await import('../src/cost-overlay.js');
      return module.costOverlayStringLexeme?.(value) ?? '<unavailable>';
    } catch {
      return '<unavailable>';
    }
  }

  it('writes a pending edit as an escaped STEP string literal', async () => {
    // The lexeme is what a re-serializing reader would carry through, so an
    // unescaped apostrophe would terminate the literal early. STEP escapes a
    // quote by doubling it.
    expect(await lexemeFor("Owner's supply")).toBe("'Owner''s supply'");
    expect(await lexemeFor('')).toBe("''");
    expect(await lexemeFor("''")).toBe("''''''");
  });

  it('an overlay that touches nothing returns the same graph as no overlay at all', () => {
    const plain = extractCostOnDemand(buildStoreFromStep(FIXTURE));
    const overlaid = extractCostOnDemand(buildStoreFromStep(FIXTURE), {
      overlay: overlay({ isDeleted: () => false, getAttributeMutationsForEntity: () => [] }),
    });
    expect(JSON.stringify(overlaid)).toBe(JSON.stringify(plain));
  });
});
