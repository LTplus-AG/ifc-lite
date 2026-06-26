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

/**
 * Build a valid 22-char IFC GlobalId from a short, charset-safe label.
 * The merge's GlobalId reconciliation only activates on real 22-char ids, so
 * mixed-unit / shared-GUID tests must use these (the short 'g1'/'g2' ids in the
 * legacy tests are intentionally ignored by that logic).
 */
const guid = (label: string): string => (label + '0'.repeat(22)).slice(0, 22);

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

  // Regression: github.com/LTplus-AG/ifc-lite/issues/1332
  // A model whose length unit differs from the first model's must NOT be folded
  // into the first project's unit (which silently rescales its coordinates).
  // Instead it is federated: it keeps its own IfcProject, IfcUnitAssignment and
  // representation context, and its raw coordinates are copied verbatim.
  describe('unit-aware federation (#1332)', () => {
    // model1 = feet (lengthUnitScale 0.3048); model2 = metres (1.0). maxId(m1)=9.
    const electrical = (): MergeModelInput => {
      const m = buildModel('elec', 'Electrical', [
        [1, 'IFCPROJECT', `#1=IFCPROJECT('${guid('elecProj')}',$,'Elec',$,$,$,$,(#3),#2);`],
        [2, 'IFCUNITASSIGNMENT', '#2=IFCUNITASSIGNMENT((#9));'],
        [3, 'IFCGEOMETRICREPRESENTATIONCONTEXT', "#3=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#8,$);"],
        [4, 'IFCSITE', `#4=IFCSITE('${guid('elecSite')}',$,'Site',$,$,$,$,$,$,$);`],
        [5, 'IFCWALL', `#5=IFCWALL('${guid('elecWall')}',$,'W',$,$,#6,$,$);`],
        [6, 'IFCCARTESIANPOINT', '#6=IFCCARTESIANPOINT((100.,200.,300.));'],
        [7, 'IFCRELAGGREGATES', `#7=IFCRELAGGREGATES('${guid('elecAgg')}',$,$,$,#1,(#4));`],
        [8, 'IFCCARTESIANPOINT', '#8=IFCCARTESIANPOINT((0.,0.,0.));'],
        [9, 'IFCSIUNIT', '#9=IFCSIUNIT(*,.LENGTHUNIT.,$,.FOOT.);'],
      ]);
      m.lengthUnitScale = 0.3048;
      return m;
    };
    const architecture = (): MergeModelInput => {
      const m = buildModel('arch', 'Architecture', [
        [1, 'IFCPROJECT', `#1=IFCPROJECT('${guid('archProj')}',$,'Arch',$,$,$,$,(#3),#2);`],
        [2, 'IFCUNITASSIGNMENT', '#2=IFCUNITASSIGNMENT((#9));'],
        [3, 'IFCGEOMETRICREPRESENTATIONCONTEXT', "#3=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#8,$);"],
        [4, 'IFCSITE', `#4=IFCSITE('${guid('archSite')}',$,'Site',$,$,$,$,$,$,$);`],
        [5, 'IFCCOLUMN', `#5=IFCCOLUMN('${guid('archCol')}',$,'C',$,$,#6,$,$);`],
        [6, 'IFCCARTESIANPOINT', '#6=IFCCARTESIANPOINT((1.5,2.5,3.5));'],
        [7, 'IFCRELAGGREGATES', `#7=IFCRELAGGREGATES('${guid('archAgg')}',$,$,$,#1,(#4));`],
        [8, 'IFCCARTESIANPOINT', '#8=IFCCARTESIANPOINT((0.,0.,0.));'],
        [9, 'IFCSIUNIT', '#9=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);'],
      ]);
      m.lengthUnitScale = 1.0;
      return m;
    };

    it('keeps the divergent-unit model as its own project + units (no remap, no dedup)', () => {
      const result = new MergedExporter([electrical(), architecture()]).export({ schema: 'IFC4' });
      const content = decode(result.content);

      // First (feet) model unchanged.
      expect(content).toContain(`#1=IFCPROJECT('${guid('elecProj')}'`);

      // Second (metre) model federated: its project is KEPT (offset 9 → #10),
      // NOT skipped and NOT remapped onto the first project.
      expect(content).toContain(`#10=IFCPROJECT('${guid('archProj')}'`);
      // Its own unit assignment and context survive (not deduplicated).
      expect(content).toContain('#11=IFCUNITASSIGNMENT');
      expect(content).toContain('#12=IFCGEOMETRICREPRESENTATIONCONTEXT');
      // Output is a federation: exactly two IfcProject roots.
      expect(content.match(/=IFCPROJECT\(/g)?.length).toBe(2);

      // The metre aggregate points at the metre project (#10) and site (#13) —
      // proof it was NOT reparented onto the feet project (#1).
      expect(content).toMatch(
        new RegExp(`#16=IFCRELAGGREGATES\\('${guid('archAgg')}',\\$,\\$,\\$,#10,\\(#13\\)\\)`),
      );

      // Coordinates copied verbatim — not rescaled into the foot unit.
      expect(content).toContain('(1.5,2.5,3.5)');
      expect(findDanglingRefs(content)).toEqual([]);
    });

    it('re-stamps shared GlobalIds across a unit boundary (no duplicate GUID errors)', () => {
      // Both disciplines reuse the same Site GlobalId (the Duplex case).
      const elec = buildModel('elec', 'Electrical', [
        [1, 'IFCPROJECT', `#1=IFCPROJECT('${guid('m1Proj')}',$,'Elec',$,$,$,$,$,#2);`],
        [2, 'IFCUNITASSIGNMENT', '#2=IFCUNITASSIGNMENT((#4));'],
        [3, 'IFCSITE', `#3=IFCSITE('${guid('sharedSite')}',$,'Site',$,$,$,$,$,$,$);`],
        [4, 'IFCSIUNIT', '#4=IFCSIUNIT(*,.LENGTHUNIT.,$,.FOOT.);'],
      ]);
      elec.lengthUnitScale = 0.3048;
      const arch = buildModel('arch', 'Architecture', [
        [1, 'IFCPROJECT', `#1=IFCPROJECT('${guid('m2Proj')}',$,'Arch',$,$,$,$,$,#2);`],
        [2, 'IFCUNITASSIGNMENT', '#2=IFCUNITASSIGNMENT((#4));'],
        [3, 'IFCSITE', `#3=IFCSITE('${guid('sharedSite')}',$,'Site',$,$,$,$,$,$,$);`],
        [4, 'IFCSIUNIT', '#4=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);'],
      ]);
      arch.lengthUnitScale = 1.0;

      const content = decode(new MergedExporter([elec, arch]).export({ schema: 'IFC4' }).content);

      // The shared GlobalId must appear exactly once (kept on the first site).
      expect(content.match(new RegExp(guid('sharedSite'), 'g'))?.length).toBe(1);
      // Both sites are still present (federated, not unified) — the second got a
      // fresh GlobalId so the file has no duplicate-GUID error.
      expect(content.match(/=IFCSITE\(/g)?.length).toBe(2);
      expect(content.match(/=IFCPROJECT\(/g)?.length).toBe(2);
      expect(findDanglingRefs(content)).toEqual([]);
    });

    it('unifies (not duplicates) shared GlobalIds when models share a unit', () => {
      // Same unit (both metres) + a shared wall GlobalId → genuinely the same
      // entity, so it is unified to one instance and references are remapped.
      const m1 = buildModel('m1', 'Arch', [
        [1, 'IFCPROJECT', `#1=IFCPROJECT('${guid('m1Proj')}',$,'Arch',$,$,$,$,$,$);`],
        [2, 'IFCWALL', `#2=IFCWALL('${guid('sharedWall')}',$,'W',$,$,$,$,$);`],
      ]);
      const m2 = buildModel('m2', 'Struct', [
        [1, 'IFCPROJECT', `#1=IFCPROJECT('${guid('m2Proj')}',$,'Struct',$,$,$,$,$,$);`],
        [2, 'IFCWALL', `#2=IFCWALL('${guid('sharedWall')}',$,'W',$,$,$,$,$);`],
        [3, 'IFCRELDEFINESBYPROPERTIES', `#3=IFCRELDEFINESBYPROPERTIES('${guid('m2Rel')}',$,$,$,(#2),#4);`],
        [4, 'IFCPROPERTYSET', `#4=IFCPROPERTYSET('${guid('m2Pset')}',$,'Pset',$,$);`],
      ]);

      const content = decode(new MergedExporter([m1, m2]).export({ schema: 'IFC4' }).content);

      // The shared wall is emitted once; the project is unified (single root).
      expect(content.match(new RegExp(guid('sharedWall'), 'g'))?.length).toBe(1);
      expect(content.match(/=IFCPROJECT\(/g)?.length).toBe(1);
      // m2's relationship is reparented onto the unified wall (#2), not m2's
      // skipped copy (which would have been #4 after the offset of 2).
      expect(content).toMatch(
        new RegExp(`IFCRELDEFINESBYPROPERTIES\\('${guid('m2Rel')}',\\$,\\$,\\$,\\(#2\\),#6\\)`),
      );
      expect(findDanglingRefs(content)).toEqual([]);
    });

    it("'assume-shared' forces unification even when units differ", () => {
      const elec = buildModel('elec', 'Electrical', [
        [1, 'IFCPROJECT', `#1=IFCPROJECT('${guid('m1Proj')}',$,'Elec',$,$,$,$,$,$);`],
        [2, 'IFCSITE', `#2=IFCSITE('${guid('sharedSite')}',$,'Site',$,$,$,$,$,$,$);`],
      ]);
      elec.lengthUnitScale = 0.3048;
      const arch = buildModel('arch', 'Architecture', [
        [1, 'IFCPROJECT', `#1=IFCPROJECT('${guid('m2Proj')}',$,'Arch',$,$,$,$,$,$);`],
        [2, 'IFCSITE', `#2=IFCSITE('${guid('sharedSite')}',$,'Site',$,$,$,$,$,$,$);`],
      ]);
      arch.lengthUnitScale = 1.0;

      const content = decode(
        new MergedExporter([elec, arch]).export({ schema: 'IFC4', unitReconciliation: 'assume-shared' }).content,
      );

      // Forced single project + unified site despite the unit mismatch.
      expect(content.match(/=IFCPROJECT\(/g)?.length).toBe(1);
      expect(content.match(/=IFCSITE\(/g)?.length).toBe(1);
      expect(findDanglingRefs(content)).toEqual([]);
    });

    it('federates via exportAsync as well', async () => {
      const result = await new MergedExporter([electrical(), architecture()]).exportAsync({ schema: 'IFC4' });
      const content = decode(result.content);
      expect(content.match(/=IFCPROJECT\(/g)?.length).toBe(2);
      expect(content).toContain('(1.5,2.5,3.5)');
      expect(findDanglingRefs(content)).toEqual([]);
    });

    it('surfaces a conformance warning when federation triggers (and none otherwise)', () => {
      const federated = new MergedExporter([electrical(), architecture()]).export({ schema: 'IFC4' });
      expect(federated.stats.federatedModelCount).toBe(1);
      expect(federated.stats.warnings.length).toBe(1);
      expect(federated.stats.warnings[0]).toMatch(/IfcSingleProjectInstance/);

      // Two same-unit models: no federation, no warning.
      const a = buildModel('a', 'A', [[1, 'IFCPROJECT', `#1=IFCPROJECT('${guid('aProj')}',$,'A',$,$,$,$,$,$);`]]);
      const b = buildModel('b', 'B', [[1, 'IFCPROJECT', `#1=IFCPROJECT('${guid('bProj')}',$,'B',$,$,$,$,$,$);`]]);
      const clean = new MergedExporter([a, b]).export({ schema: 'IFC4' });
      expect(clean.stats.federatedModelCount).toBe(0);
      expect(clean.stats.warnings).toEqual([]);
    });

    // Regression (review of #1332): objectified relationships must NOT be
    // dropped on a GlobalId match — same GlobalId does not imply same membership,
    // so dropping one orphans its elements from the spatial tree.
    it('keeps (re-stamps) a relationship with a shared GlobalId instead of dropping its members', () => {
      const a = buildModel('a', 'Arch', [
        [1, 'IFCPROJECT', `#1=IFCPROJECT('${guid('projA')}',$,'A',$,$,$,$,$,$);`],
        [2, 'IFCBUILDINGSTOREY', `#2=IFCBUILDINGSTOREY('${guid('sharedStorey')}',$,'L1',$,$,$,$,$,.ELEMENT.,0.);`],
        [3, 'IFCWALL', `#3=IFCWALL('${guid('wallA')}',$,'WA',$,$,$,$,$);`],
        [4, 'IFCRELCONTAINEDINSPATIALSTRUCTURE', `#4=IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid('sharedRel')}',$,$,$,(#3),#2);`],
      ]);
      const b = buildModel('b', 'Struct', [
        [1, 'IFCPROJECT', `#1=IFCPROJECT('${guid('projB')}',$,'B',$,$,$,$,$,$);`],
        [2, 'IFCBUILDINGSTOREY', `#2=IFCBUILDINGSTOREY('${guid('sharedStorey')}',$,'L1',$,$,$,$,$,.ELEMENT.,0.);`],
        [3, 'IFCCOLUMN', `#3=IFCCOLUMN('${guid('colB')}',$,'CB',$,$,$,$,$);`],
        [4, 'IFCRELCONTAINEDINSPATIALSTRUCTURE', `#4=IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid('sharedRel')}',$,$,$,(#3),#2);`],
      ]);

      const content = decode(new MergedExporter([a, b]).export({ schema: 'IFC4' }).content);

      // Storey is unified (one instance), but BOTH containment relationships survive.
      expect(content.match(/=IFCBUILDINGSTOREY\(/g)?.length).toBe(1);
      expect(content.match(/=IFCRELCONTAINEDINSPATIALSTRUCTURE\(/g)?.length).toBe(2);
      // B's column is kept (#3 + offset 4 = #7) and contained in the unified storey #2.
      expect(content).toContain(`#7=IFCCOLUMN('${guid('colB')}'`);
      expect(content).toMatch(/IFCRELCONTAINEDINSPATIALSTRUCTURE\([^)]*,\(#7\),#2\)/);
      // The shared relationship GlobalId survives once; B's copy was re-stamped.
      expect(content.match(new RegExp(guid('sharedRel'), 'g'))?.length).toBe(1);
      expect(findDanglingRefs(content)).toEqual([]);
    });

    // Regression (review of #1332): a non-rooted resource entity whose Name is
    // coincidentally a 22-char GlobalId-charset string must NOT be treated as a
    // GlobalId, or its value would be unified away / its Name overwritten.
    it('does not mistake a 22-char property Name for a GlobalId', () => {
      const propName = guid('ThermalRes'); // 22 chars, valid GlobalId charset
      const a = buildModel('a', 'Arch', [
        [1, 'IFCPROJECT', `#1=IFCPROJECT('${guid('projA')}',$,'A',$,$,$,$,$,$);`],
        [2, 'IFCWALL', `#2=IFCWALL('${guid('wallA')}',$,'WA',$,$,$,$,$);`],
        [3, 'IFCPROPERTYSET', `#3=IFCPROPERTYSET('${guid('psetA')}',$,'Pset_X',$,(#4));`],
        [4, 'IFCPROPERTYSINGLEVALUE', `#4=IFCPROPERTYSINGLEVALUE('${propName}',$,IFCTEXT('aVal'),$);`],
        [5, 'IFCRELDEFINESBYPROPERTIES', `#5=IFCRELDEFINESBYPROPERTIES('${guid('relA')}',$,$,$,(#2),#3);`],
      ]);
      const b = buildModel('b', 'Struct', [
        [1, 'IFCPROJECT', `#1=IFCPROJECT('${guid('projB')}',$,'B',$,$,$,$,$,$);`],
        [2, 'IFCWALL', `#2=IFCWALL('${guid('wallB')}',$,'WB',$,$,$,$,$);`],
        [3, 'IFCPROPERTYSET', `#3=IFCPROPERTYSET('${guid('psetB')}',$,'Pset_X',$,(#4));`],
        [4, 'IFCPROPERTYSINGLEVALUE', `#4=IFCPROPERTYSINGLEVALUE('${propName}',$,IFCTEXT('bVal'),$);`],
        [5, 'IFCRELDEFINESBYPROPERTIES', `#5=IFCRELDEFINESBYPROPERTIES('${guid('relB')}',$,$,$,(#2),#3);`],
      ]);

      const content = decode(new MergedExporter([a, b]).export({ schema: 'IFC4' }).content);

      // Both property atoms survive with their own distinct values and Name intact.
      expect(content.match(/=IFCPROPERTYSINGLEVALUE\(/g)?.length).toBe(2);
      expect(content).toContain("IFCTEXT('aVal')");
      expect(content).toContain("IFCTEXT('bVal')");
      expect(content.match(new RegExp(propName, 'g'))?.length).toBe(2);
      expect(findDanglingRefs(content)).toEqual([]);
    });

    // Regression (review of #1332): in a 3+ model merge, a unit-compatible model
    // must not be unified onto an entity emitted by a FEDERATED (different-unit)
    // model just because the GlobalId matches — that would reintroduce the
    // mis-scale transitively.
    it('does not unify a compatible model onto a federated entity sharing a GlobalId', () => {
      const sharedWall = guid('sharedWall');
      const a = buildModel('a', 'PrimaryMetre', [
        [1, 'IFCPROJECT', `#1=IFCPROJECT('${guid('projA')}',$,'A',$,$,$,$,$,$);`],
        [2, 'IFCWALL', `#2=IFCWALL('${guid('wallA')}',$,'WA',$,$,#3,$,$);`],
        [3, 'IFCCARTESIANPOINT', '#3=IFCCARTESIANPOINT((9.,9.,9.));'],
      ]);
      a.lengthUnitScale = 1.0; // primary = metres
      const b = buildModel('b', 'Feet', [
        [1, 'IFCPROJECT', `#1=IFCPROJECT('${guid('projB')}',$,'B',$,$,$,$,$,$);`],
        [2, 'IFCWALL', `#2=IFCWALL('${sharedWall}',$,'BW-feet',$,$,#3,$,$);`],
        [3, 'IFCCARTESIANPOINT', '#3=IFCCARTESIANPOINT((100.,100.,100.));'],
      ]);
      b.lengthUnitScale = 0.3048; // federated (feet)
      const c = buildModel('c', 'Metre', [
        [1, 'IFCPROJECT', `#1=IFCPROJECT('${guid('projC')}',$,'C',$,$,$,$,$,$);`],
        [2, 'IFCWALL', `#2=IFCWALL('${sharedWall}',$,'CW-metres',$,$,#3,$,$);`],
        [3, 'IFCCARTESIANPOINT', '#3=IFCCARTESIANPOINT((2.,2.,2.));'],
      ]);
      c.lengthUnitScale = 1.0; // compatible with primary

      const content = decode(new MergedExporter([a, b, c]).export({ schema: 'IFC4' }).content);

      // C's metre wall must NOT be dropped/reparented onto B's feet wall.
      expect(content).toContain("'CW-metres'");
      expect(content).toContain('(2.,2.,2.)'); // C's coordinate is preserved, not orphaned to feet space
      expect(content.match(/=IFCWALL\(/g)?.length).toBe(3); // all three walls survive
      // The shared GlobalId is kept once (on B, first emitter); C's was re-stamped.
      expect(content.match(new RegExp(sharedWall, 'g'))?.length).toBe(1);
      expect(findDanglingRefs(content)).toEqual([]);
    });

    // Regression (CodeRabbit on PR): schema conversion can replace an
    // unsupported rooted type with an IFCPROXY carrying a freshly-minted
    // GlobalId. The emitted (not source) GlobalId must be registered, or a later
    // model with the original GlobalId would be unified onto that proxy.
    it('registers the emitted GlobalId after IFCPROXY conversion (no false unify)', () => {
      const sharedGuid = guid('sharedAlign');
      // IfcAlignmentHorizontal has no IFC2X3 representation → replaced by an
      // IFCPROXY carrying a freshly-minted GlobalId (schema-converter.ts).
      const m1 = buildModel('m1', 'A', [
        [1, 'IFCPROJECT', `#1=IFCPROJECT('${guid('p1')}',$,'A',$,$,$,$,$,$);`],
        [2, 'IFCALIGNMENTHORIZONTAL', `#2=IFCALIGNMENTHORIZONTAL('${sharedGuid}',$,'AL',$,$,$);`],
      ]);
      const m2 = buildModel('m2', 'B', [
        [1, 'IFCPROJECT', `#1=IFCPROJECT('${guid('p2')}',$,'B',$,$,$,$,$,$);`],
        [2, 'IFCALIGNMENTHORIZONTAL', `#2=IFCALIGNMENTHORIZONTAL('${sharedGuid}',$,'AL',$,$,$);`],
      ]);

      const content = decode(new MergedExporter([m1, m2]).export({ schema: 'IFC2X3' }).content);

      // Both alignments survive as proxies; m2 was not dropped onto m1's proxy.
      expect(content.match(/=IFCPROXY\(/g)?.length).toBe(2);
      // The original GlobalId was replaced by the minted proxy ids on both.
      expect(content).not.toContain(sharedGuid);
      expect(findDanglingRefs(content)).toEqual([]);
    });

    // Regression (CodeRabbit on PR): the rooted-entity denylist must cover other
    // non-rooted resource entities that lead with a string, e.g. IfcTextLiteral.
    it('does not mistake a 22-char IfcTextLiteral Literal for a GlobalId', () => {
      const literal = guid('SomeLiteralText'); // 22-char, GlobalId charset
      const m1 = buildModel('m1', 'A', [
        [1, 'IFCPROJECT', `#1=IFCPROJECT('${guid('p1')}',$,'A',$,$,$,$,$,$);`],
        [2, 'IFCTEXTLITERAL', `#2=IFCTEXTLITERAL('${literal}',#3,.LEFT.);`],
        [3, 'IFCAXIS2PLACEMENT2D', '#3=IFCAXIS2PLACEMENT2D(#4,$);'],
        [4, 'IFCCARTESIANPOINT', '#4=IFCCARTESIANPOINT((0.,0.));'],
      ]);
      const m2 = buildModel('m2', 'B', [
        [1, 'IFCPROJECT', `#1=IFCPROJECT('${guid('p2')}',$,'B',$,$,$,$,$,$);`],
        [2, 'IFCTEXTLITERAL', `#2=IFCTEXTLITERAL('${literal}',#3,.LEFT.);`],
        [3, 'IFCAXIS2PLACEMENT2D', '#3=IFCAXIS2PLACEMENT2D(#4,$);'],
        [4, 'IFCCARTESIANPOINT', '#4=IFCCARTESIANPOINT((0.,0.));'],
      ]);

      const content = decode(new MergedExporter([m1, m2]).export({ schema: 'IFC4' }).content);

      // Both text literals survive (not unified away); the literal is untouched.
      expect(content.match(/=IFCTEXTLITERAL\(/g)?.length).toBe(2);
      expect(content.match(new RegExp(literal, 'g'))?.length).toBe(2);
      expect(findDanglingRefs(content)).toEqual([]);
    });
  });
});
