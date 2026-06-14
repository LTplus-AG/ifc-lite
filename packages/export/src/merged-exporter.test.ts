/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { MergedExporter, type MergeModelInput } from './merged-exporter.js';
import type { IfcDataStore } from '@ifc-lite/parser';

type MockEntityRef = { expressId: number; type: string; byteOffset: number; byteLength: number; lineNumber: number };

/**
 * Helper: build a minimal IfcDataStore from STEP entity lines.
 * Each entry is [expressId, type, stepText].
 *
 * `deferredIds` mirrors the parser's `deferPropertyAtomIndex` mode: those
 * entities live in the source buffer but are split out of `entityIndex.byId`
 * (and `byType`) into a separate `deferredEntityIndex`, exactly as the columnar
 * parser does for property atoms on huge files.
 */
function buildMockDataStore(
  entries: Array<[number, string, string]>,
  deferredIds?: Set<number>,
): IfcDataStore {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const byId = new Map<number, MockEntityRef>();
  const deferred = new Map<number, MockEntityRef>();
  const byType = new Map<string, number[]>();
  let offset = 0;

  for (const [id, type, text] of entries) {
    const encoded = encoder.encode(text);
    const upper = type.toUpperCase();
    const ref: MockEntityRef = { expressId: id, type: upper, byteOffset: offset, byteLength: encoded.byteLength, lineNumber: 0 };
    if (deferredIds?.has(id)) {
      // Deferred atoms are NOT in byId or byType (matches real parser behaviour).
      deferred.set(id, ref);
    } else {
      byId.set(id, ref);
      if (!byType.has(upper)) byType.set(upper, []);
      byType.get(upper)!.push(id);
    }
    parts.push(encoded);
    offset += encoded.byteLength;
  }

  const source = new Uint8Array(offset);
  let pos = 0;
  for (const part of parts) {
    source.set(part, pos);
    pos += part.byteLength;
  }

  return {
    fileSize: offset,
    schemaVersion: 'IFC4',
    entityCount: entries.length,
    parseTime: 0,
    source,
    entityIndex: { byId, byType },
    ...(deferred.size > 0 ? { deferredEntityIndex: deferred } : {}),
  } as unknown as IfcDataStore;
}

function buildModel(id: string, name: string, entries: Array<[number, string, string]>, deferredIds?: Set<number>): MergeModelInput {
  return { id, name, dataStore: buildMockDataStore(entries, deferredIds) };
}

/** Decode Uint8Array content to string for test assertions */
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** Count `#N` references in the output that have no `#N=` definition. */
function findDanglingRefs(content: string): number[] {
  const defined = new Set<number>();
  for (const m of content.matchAll(/(^|\n)#(\d+)=/g)) defined.add(+m[2]);
  const dangling = new Set<number>();
  for (const m of content.matchAll(/#(\d+)/g)) {
    const id = +m[1];
    if (!defined.has(id)) dangling.add(id);
  }
  return [...dangling].sort((a, b) => a - b);
}

describe('MergedExporter', () => {
  it('should export a single model unchanged', () => {
    const model = buildModel('m1', 'Model1', [
      [1, 'IFCPROJECT', "#1=IFCPROJECT('g1',$,'Project',$,$,$,$,$,$);"],
      [2, 'IFCSITE', "#2=IFCSITE('g2',$,'Site',$,$,$,$,$,$,$);"],
      [3, 'IFCWALL', "#3=IFCWALL('g3',#1,'Wall',$,$,$,$,$);"],
    ]);

    const exporter = new MergedExporter([model]);
    const result = exporter.export({ schema: 'IFC4', projectStrategy: 'keep-first' });
    const content = decode(result.content);

    expect(content).toContain('DATA;');
    expect(content).toContain('END-ISO-10303-21;');
    expect(content).toContain("#1=IFCPROJECT('g1'");
    expect(content).toContain("#3=IFCWALL('g3'");
    expect(result.stats.modelCount).toBe(1);
    expect(result.stats.totalEntityCount).toBe(3);
  });

  it('should remap IDs for second model to avoid collisions', () => {
    const model1 = buildModel('m1', 'Arch', [
      [1, 'IFCPROJECT', "#1=IFCPROJECT('g1',$,'P',$,$,$,$,$,$);"],
      [2, 'IFCSITE', "#2=IFCSITE('g2',$,'S',$,$,$,$,$,$,$);"],
      [3, 'IFCWALL', "#3=IFCWALL('g3',#1,'W',$,#2,$,$,$);"],
    ]);

    const model2 = buildModel('m2', 'Struct', [
      [1, 'IFCPROJECT', "#1=IFCPROJECT('g4',$,'P2',$,$,$,$,$,$);"],
      [2, 'IFCBUILDING', "#2=IFCBUILDING('g5',$,'B',$,$,$,$,$,$,$);"],
      [3, 'IFCCOLUMN', "#3=IFCCOLUMN('g6',#1,'C',$,#2,$,$,$);"],
    ]);

    const exporter = new MergedExporter([model1, model2]);
    const result = exporter.export({ schema: 'IFC4', projectStrategy: 'keep-first' });

    // First model entities should have original IDs (offset 0)
    expect(decode(result.content)).toContain("#1=IFCPROJECT('g1'");
    expect(decode(result.content)).toContain("#3=IFCWALL('g3'");

    // Second model entities should have remapped IDs (offset = maxId of model1 = 3)
    // So #1→#4, #2→#5, #3→#6
    // But IfcProject from model2 should be SKIPPED (entity not emitted)
    expect(decode(result.content)).not.toContain("#4=IFCPROJECT");

    // Building and Column should be remapped: #2→#5, #3→#6
    expect(decode(result.content)).toContain('#5=IFCBUILDING');
    expect(decode(result.content)).toContain('#6=IFCCOLUMN');

    // Column originally referenced #1 (project). After merge, that reference
    // should be remapped to #1 (first model's project), NOT #4 (offset)
    expect(decode(result.content)).toMatch(/#6=IFCCOLUMN\('g6',#1/);

    expect(result.stats.modelCount).toBe(2);
  });

  it('should handle visibility filtering per model in merged export', () => {
    const model1 = buildModel('m1', 'Arch', [
      [1, 'IFCPROJECT', "#1=IFCPROJECT('g1',$,'P',$,$,$,$,$,$);"],
      [2, 'IFCWALL', "#2=IFCWALL('g2',$,'W1',$,$,$,$,$);"],
      [3, 'IFCDOOR', "#3=IFCDOOR('g3',$,'D1',$,$,$,$,$);"],
    ]);

    const exporter = new MergedExporter([model1]);
    const result = exporter.export({
      schema: 'IFC4',
      projectStrategy: 'keep-first',
      visibleOnly: true,
      hiddenEntityIdsByModel: new Map([['m1', new Set([3])]]), // Hide door
    });

    expect(decode(result.content)).toContain("#1=IFCPROJECT"); // infrastructure always included
    expect(decode(result.content)).toContain("#2=IFCWALL");    // visible wall
    expect(decode(result.content)).not.toContain("#3=IFCDOOR"); // hidden door
  });

  it('should unify single site and remap spatial chain', () => {
    // Model1: Project#1 → Site#2 (via RelAgg#3)
    const model1 = buildModel('m1', 'Arch', [
      [1, 'IFCPROJECT', "#1=IFCPROJECT('g1',$,'P',$,$,$,$,$,$);"],
      [2, 'IFCSITE', "#2=IFCSITE('g2',$,'S',$,$,$,$,$,$,$);"],
      [3, 'IFCRELAGGREGATES', "#3=IFCRELAGGREGATES('r1',$,$,$,#1,(#2));"],
    ]);

    // Model2: Project#1 → Site#2 → Building#3
    const model2 = buildModel('m2', 'Struct', [
      [1, 'IFCPROJECT', "#1=IFCPROJECT('g3',$,'P2',$,$,$,$,$,$);"],
      [2, 'IFCSITE', "#2=IFCSITE('g4',$,'S2',$,$,$,$,$,$,$);"],
      [3, 'IFCBUILDING', "#3=IFCBUILDING('g5',$,'B',$,$,$,$,$,$,$);"],
      [4, 'IFCRELAGGREGATES', "#4=IFCRELAGGREGATES('r2',$,$,$,#1,(#2));"],
      [5, 'IFCRELAGGREGATES', "#5=IFCRELAGGREGATES('r3',$,$,$,#2,(#3));"],
    ]);

    const exporter = new MergedExporter([model1, model2]);
    const result = exporter.export({ schema: 'IFC4', projectStrategy: 'keep-first' });

    // Project and Site from model2 should be unified (single instance each)
    expect(decode(result.content)).not.toContain("IFCPROJECT('g3'");
    expect(decode(result.content)).not.toContain("IFCSITE('g4'");

    // Model2's RelAgg Project→Site: fully redundant (both project and site
    // remapped to model1's) — should be SKIPPED to avoid duplicate tree nodes
    expect(decode(result.content)).not.toContain("IFCRELAGGREGATES('r2'");

    // Model2's RelAgg Site→Building: NOT redundant (building is new, not remapped)
    // site→#2 (unified), building→#6 (offset). Entity #5+offset(3)=#8
    expect(decode(result.content)).toMatch(/#8=IFCRELAGGREGATES\('r3',\$,\$,\$,#2,\(#6\)\)/);

    // Model2's building is kept (no building in model1 to match)
    expect(decode(result.content)).toContain("#6=IFCBUILDING('g5'");
  });

  it('should unify storeys with matching names', () => {
    // Model1: maxId=4, offset=0
    const model1 = buildModel('m1', 'Arch', [
      [1, 'IFCPROJECT', "#1=IFCPROJECT('g1',$,'P',$,$,$,$,$,$);"],
      [2, 'IFCBUILDINGSTOREY', "#2=IFCBUILDINGSTOREY('g2',$,'Ground Floor',$,$,$,$,$,.ELEMENT.,0.);"],
      [3, 'IFCBUILDINGSTOREY', "#3=IFCBUILDINGSTOREY('g3',$,'First Floor',$,$,$,$,$,.ELEMENT.,3000.);"],
      [4, 'IFCWALL', "#4=IFCWALL('g4',$,'W1',$,#2,$,$,$);"],
    ]);

    // Model2: offset=4
    const model2 = buildModel('m2', 'Struct', [
      [1, 'IFCPROJECT', "#1=IFCPROJECT('g5',$,'P2',$,$,$,$,$,$);"],
      [2, 'IFCBUILDINGSTOREY', "#2=IFCBUILDINGSTOREY('g6',$,'Ground Floor',$,$,$,$,$,.ELEMENT.,0.);"],
      [3, 'IFCBUILDINGSTOREY', "#3=IFCBUILDINGSTOREY('g7',$,'First Floor',$,$,$,$,$,.ELEMENT.,3000.);"],
      [4, 'IFCCOLUMN', "#4=IFCCOLUMN('g8',$,'C1',$,#2,$,$,$);"],
      [5, 'IFCRELCONTAINEDINSPATIALSTRUCTURE', "#5=IFCRELCONTAINEDINSPATIALSTRUCTURE('r1',$,$,$,(#4),#2);"],
    ]);

    const exporter = new MergedExporter([model1, model2]);
    const result = exporter.export({ schema: 'IFC4', projectStrategy: 'keep-first' });

    // Both storeys should be unified (same names)
    expect(decode(result.content)).not.toContain("IFCBUILDINGSTOREY('g6'");
    expect(decode(result.content)).not.toContain("IFCBUILDINGSTOREY('g7'");

    // Column from model2: #4→#8 (offset), references #2(storey)→#2 (unified)
    expect(decode(result.content)).toMatch(/#8=IFCCOLUMN\('g8',\$,'C1',\$,#2/);

    // RelContained: (#4→#8), #2→#2 (unified storey)
    expect(decode(result.content)).toMatch(/#9=IFCRELCONTAINEDINSPATIALSTRUCTURE\('r1',\$,\$,\$,\(#8\),#2\)/);
  });

  it('should unify storeys by elevation when names differ', () => {
    const model1 = buildModel('m1', 'Arch', [
      [1, 'IFCPROJECT', "#1=IFCPROJECT('g1',$,'P',$,$,$,$,$,$);"],
      [2, 'IFCBUILDINGSTOREY', "#2=IFCBUILDINGSTOREY('g2',$,'EG',$,$,$,$,$,.ELEMENT.,0.);"],
      [3, 'IFCBUILDINGSTOREY', "#3=IFCBUILDINGSTOREY('g3',$,'OG1',$,$,$,$,$,.ELEMENT.,3000.);"],
    ]);

    const model2 = buildModel('m2', 'Struct', [
      [1, 'IFCPROJECT', "#1=IFCPROJECT('g4',$,'P2',$,$,$,$,$,$);"],
      [2, 'IFCBUILDINGSTOREY', "#2=IFCBUILDINGSTOREY('g5',$,'Ground',$,$,$,$,$,.ELEMENT.,0.);"],
      [3, 'IFCBUILDINGSTOREY', "#3=IFCBUILDINGSTOREY('g6',$,'Level 1',$,$,$,$,$,.ELEMENT.,3000.);"],
    ]);

    const exporter = new MergedExporter([model1, model2]);
    const result = exporter.export({ schema: 'IFC4', projectStrategy: 'keep-first' });

    // Names differ but elevations match → storeys should be unified
    expect(decode(result.content)).not.toContain("IFCBUILDINGSTOREY('g5'");
    expect(decode(result.content)).not.toContain("IFCBUILDINGSTOREY('g6'");

    // First model's storeys are preserved
    expect(decode(result.content)).toContain("IFCBUILDINGSTOREY('g2'");
    expect(decode(result.content)).toContain("IFCBUILDINGSTOREY('g3'");
  });

  it('should keep unmatched storeys as separate entities', () => {
    // Model1: maxId=2, offset=0
    const model1 = buildModel('m1', 'Arch', [
      [1, 'IFCPROJECT', "#1=IFCPROJECT('g1',$,'P',$,$,$,$,$,$);"],
      [2, 'IFCBUILDINGSTOREY', "#2=IFCBUILDINGSTOREY('g2',$,'Ground Floor',$,$,$,$,$,.ELEMENT.,0.);"],
    ]);

    // Model2: offset=2
    const model2 = buildModel('m2', 'Struct', [
      [1, 'IFCPROJECT', "#1=IFCPROJECT('g3',$,'P2',$,$,$,$,$,$);"],
      [2, 'IFCBUILDINGSTOREY', "#2=IFCBUILDINGSTOREY('g4',$,'Ground Floor',$,$,$,$,$,.ELEMENT.,0.);"],
      [3, 'IFCBUILDINGSTOREY', "#3=IFCBUILDINGSTOREY('g5',$,'Roof',$,$,$,$,$,.ELEMENT.,9000.);"],
    ]);

    const exporter = new MergedExporter([model1, model2]);
    const result = exporter.export({ schema: 'IFC4', projectStrategy: 'keep-first' });

    // Ground Floor should be unified
    expect(decode(result.content)).not.toContain("IFCBUILDINGSTOREY('g4'");

    // Roof has no match in model1 → kept as new entity (#3+2=#5)
    expect(decode(result.content)).toContain("#5=IFCBUILDINGSTOREY('g5'");
  });

  it('should throw if no models provided', () => {
    expect(() => new MergedExporter([])).toThrow('at least one model');
  });

  // Regression: github.com/LTplus-AG/ifc-lite/issues/1110
  // When the parser defers property atoms out of byId (deferPropertyAtomIndex
  // on huge files), the merge must still emit them — otherwise the kept
  // IfcPropertySet/IfcElementQuantity containers reference dropped entities and
  // the output is full of dangling #-refs that strict viewers reject.
  it('should emit deferred property atoms (no dangling refs)', () => {
    // #5 (single value) and #6 (quantity) live in deferredEntityIndex, but are
    // referenced by the pset #3 and element-quantity #4 which stay in byId.
    const entries: Array<[number, string, string]> = [
      [1, 'IFCPROJECT', "#1=IFCPROJECT('g1',$,'P',$,$,$,$,$,$);"],
      [2, 'IFCWALL', "#2=IFCWALL('g2',$,'W',$,$,$,$,$);"],
      [3, 'IFCPROPERTYSET', "#3=IFCPROPERTYSET('g3',$,'Pset_Wall',$,(#5));"],
      [4, 'IFCELEMENTQUANTITY', "#4=IFCELEMENTQUANTITY('g4',$,'Qto',$,$,(#6));"],
      [5, 'IFCPROPERTYSINGLEVALUE', "#5=IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.T.),$);"],
      [6, 'IFCQUANTITYLENGTH', "#6=IFCQUANTITYLENGTH('Length',$,$,2500.,$);"],
      [7, 'IFCRELDEFINESBYPROPERTIES', "#7=IFCRELDEFINESBYPROPERTIES('g7',$,$,$,(#2),#3);"],
    ];
    const deferred = new Set([5, 6]);

    const model1 = buildModel('m1', 'Arch', entries, deferred);
    const model2 = buildModel('m2', 'Struct', entries, deferred);

    const exporter = new MergedExporter([model1, model2]);
    const result = exporter.export({ schema: 'IFC4', projectStrategy: 'keep-first' });
    const content = decode(result.content);

    // The deferred atoms must be present in the output for both models.
    expect(content).toContain("IFCPROPERTYSINGLEVALUE('IsExternal'");
    expect(content).toContain("IFCQUANTITYLENGTH('Length'");
    // Two models → the single-value atom is emitted twice (once per model).
    expect(content.match(/IFCPROPERTYSINGLEVALUE\('IsExternal'/g)?.length).toBe(2);

    // No dangling references anywhere in the merged file.
    expect(findDanglingRefs(content)).toEqual([]);
  });

  it('should emit deferred property atoms via exportAsync too', async () => {
    const entries: Array<[number, string, string]> = [
      [1, 'IFCPROJECT', "#1=IFCPROJECT('g1',$,'P',$,$,$,$,$,$);"],
      [2, 'IFCWALL', "#2=IFCWALL('g2',$,'W',$,$,$,$,$);"],
      [3, 'IFCPROPERTYSET', "#3=IFCPROPERTYSET('g3',$,'Pset_Wall',$,(#4));"],
      [4, 'IFCPROPERTYSINGLEVALUE', "#4=IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.T.),$);"],
      [5, 'IFCRELDEFINESBYPROPERTIES', "#5=IFCRELDEFINESBYPROPERTIES('g5',$,$,$,(#2),#3);"],
    ];
    const deferred = new Set([4]);

    const exporter = new MergedExporter([
      buildModel('m1', 'Arch', entries, deferred),
      buildModel('m2', 'Struct', entries, deferred),
    ]);
    const result = await exporter.exportAsync({ schema: 'IFC4', projectStrategy: 'keep-first' });
    const content = decode(result.content);

    expect(content.match(/IFCPROPERTYSINGLEVALUE\('IsExternal'/g)?.length).toBe(2);
    expect(findDanglingRefs(content)).toEqual([]);
  });

  it('should not collide remapped ids with a deferred atom at the max express id', () => {
    // Model1's highest id (10) is a DEFERRED atom — the second model's offset
    // must clear it, or model2's entities overwrite model1's deferred atom.
    const model1 = buildModel('m1', 'Arch', [
      [1, 'IFCPROJECT', "#1=IFCPROJECT('g1',$,'P',$,$,$,$,$,$);"],
      [2, 'IFCWALL', "#2=IFCWALL('g2',$,'W',$,$,$,$,$);"],
      [3, 'IFCPROPERTYSET', "#3=IFCPROPERTYSET('g3',$,'Pset',$,(#10));"],
      [10, 'IFCPROPERTYSINGLEVALUE', "#10=IFCPROPERTYSINGLEVALUE('A',$,IFCLABEL('x'),$);"],
    ], new Set([10]));
    const model2 = buildModel('m2', 'Struct', [
      [1, 'IFCPROJECT', "#1=IFCPROJECT('g4',$,'P2',$,$,$,$,$,$);"],
      [2, 'IFCCOLUMN', "#2=IFCCOLUMN('g5',$,'C',$,$,$,$,$);"],
    ]);

    const exporter = new MergedExporter([model1, model2]);
    const result = exporter.export({ schema: 'IFC4', projectStrategy: 'keep-first' });
    const content = decode(result.content);

    // Model1's deferred atom keeps id #10; model2's column must land beyond it.
    expect(content).toContain("#10=IFCPROPERTYSINGLEVALUE('A'");
    expect(content).toContain("#12=IFCCOLUMN('g5'"); // offset = maxId(10) → #2 → #12
    expect(findDanglingRefs(content)).toEqual([]);
  });

  it('should produce valid STEP structure', () => {
    const model = buildModel('m1', 'Test', [
      [1, 'IFCPROJECT', "#1=IFCPROJECT('g',$,'P',$,$,$,$,$,$);"],
    ]);

    const exporter = new MergedExporter([model]);
    const result = exporter.export({ schema: 'IFC4', projectStrategy: 'keep-first' });

    // Valid STEP file structure
    expect(decode(result.content)).toContain('ISO-10303-21;');
    expect(decode(result.content)).toContain('HEADER;');
    expect(decode(result.content)).toContain('DATA;');
    expect(decode(result.content)).toContain('ENDSEC;');
    expect(decode(result.content)).toContain('END-ISO-10303-21;');
  });
});
