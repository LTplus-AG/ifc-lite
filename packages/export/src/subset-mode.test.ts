/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `StepExportOptions.subsetEntityIds` wiring through `step-collection.ts`
 * (#2934, the "anonymized isolated export" feature): the new first branch of
 * `collectModifications` throws when combined with `visibleOnly`, and — on
 * its own — produces the same kind of closure `visibleOnly` does, just seeded
 * from a caller-picked id set instead of viewer visibility.
 *
 * Real fixtures throughout (`new IfcParser().parseColumnar`), per this
 * repo's "assert behaviour through a real fixture" rule — never a mock store
 * or a source-text assertion.
 */

import { describe, expect, it } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { StepExporter } from './step-exporter.js';

const enc = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer;

async function parse(model: string): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(enc(model));
}

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** Same helper as `visible-only-dangling-refs.test.ts`: every `#N` referenced
 *  in the output that has no `#N=` defining line. */
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

/** 22-char synthetic GlobalId, deterministic and unique per `n`. */
const guid = (n: number): string => `0GUID${String(n).padStart(17, '0')}`;

/**
 * Project #1 -> BuildingStorey #2 (Storey A) / #3 (Storey B), via one
 * IfcRelAggregates #10; Wall #4 contained in Storey A via #11, Wall #5
 * contained in Storey B via #12. Two independent, sibling branches under one
 * project — exactly the shape a "pick one wall's context" subset needs to
 * prove it drops the OTHER branch, not just the other wall's own line.
 */
const TWO_STOREY_MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('subset-fixture.ifc','2024-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('${guid(1)}',$,'Project',$,$,$,$,$,$);
#2=IFCBUILDINGSTOREY('${guid(2)}',$,'Storey A',$,$,$,$,$,$,0.);
#3=IFCBUILDINGSTOREY('${guid(3)}',$,'Storey B',$,$,$,$,$,$,3.);
#4=IFCWALL('${guid(4)}',$,'Wall A',$,$,$,$,$);
#5=IFCWALL('${guid(5)}',$,'Wall B',$,$,$,$,$);
#10=IFCRELAGGREGATES('${guid(10)}',$,$,$,#1,(#2,#3));
#11=IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid(11)}',$,$,$,(#4),#2);
#12=IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid(12)}',$,$,$,(#5),#3);
ENDSEC;
END-ISO-10303-21;`;

describe('StepExportOptions.subsetEntityIds and visibleOnly are mutually exclusive', () => {
  it('throws when both are set', async () => {
    const store = await parse(TWO_STOREY_MODEL);
    expect(() => new StepExporter(store).export({
      schema: store.schemaVersion,
      subsetEntityIds: new Set([1, 2, 4, 10, 11]),
      visibleOnly: true,
    })).toThrow(/mutually exclusive/);
  });

  it('does not throw for subsetEntityIds alone', async () => {
    const store = await parse(TWO_STOREY_MODEL);
    expect(() => new StepExporter(store).export({
      schema: store.schemaVersion,
      subsetEntityIds: new Set([1, 2, 4, 10, 11]),
    })).not.toThrow();
  });

  it('does not throw for visibleOnly alone', async () => {
    const store = await parse(TWO_STOREY_MODEL);
    expect(() => new StepExporter(store).export({
      schema: store.schemaVersion,
      visibleOnly: true,
    })).not.toThrow();
  });
});

describe('subsetEntityIds: a one-wall subset omits the other storey (anonymized isolated export)', () => {
  it('keeps Wall A, Storey A and the project; drops Wall B, Storey B and their relationship', async () => {
    const store = await parse(TWO_STOREY_MODEL);

    // The caller-picked subset: project, Storey A, Wall A, the aggregates
    // relation that links project→storeys, and the containment relation that
    // links Wall A→Storey A. #3 (Storey B), #5 (Wall B) and #12 (its
    // containment relation) are deliberately left out.
    const result = new StepExporter(store).export({
      schema: store.schemaVersion,
      subsetEntityIds: new Set([1, 2, 4, 10, 11]),
    });
    const content = decode(result.content);

    expect(content).toContain('#1=IFCPROJECT');
    expect(content).toContain('#2=IFCBUILDINGSTOREY');
    expect(content).toContain('#4=IFCWALL');
    expect(content).toContain('#10=IFCRELAGGREGATES');
    expect(content).toContain('#11=IFCRELCONTAINEDINSPATIALSTRUCTURE');

    expect(content).not.toContain('#3=IFCBUILDINGSTOREY');
    expect(content).not.toContain('#5=IFCWALL');
    expect(content).not.toContain('#12=IFCRELCONTAINEDINSPATIALSTRUCTURE');
    expect(content).not.toContain('Storey B');
    expect(content).not.toContain('Wall B');

    // #10's RelatedObjects list named both storeys; the excluded one (#3) must
    // be dropped from the LIST, not leave the relation withheld outright —
    // the same list-filtering behaviour `visibleOnly` gets from
    // `filterHiddenRefsFromRelationshipLine`.
    const rel10 = content.match(/^#10=IFCRELAGGREGATES\((.*)\);$/m);
    expect(rel10).not.toBeNull();
    expect(rel10![1]).toContain('(#2)');
    expect(rel10![1]).not.toContain('#3');

    expect(findDanglingRefs(content)).toEqual([]);
  });

  it('an empty subset still yields a structurally valid, dangling-ref-free file', async () => {
    const store = await parse(TWO_STOREY_MODEL);
    const result = new StepExporter(store).export({
      schema: store.schemaVersion,
      subsetEntityIds: new Set(),
    });
    const content = decode(result.content);

    // Nothing IfcRoot-derived was included, so every one of them is excluded
    // and none of the relationships bridging them survive either.
    expect(content).not.toContain('IFCPROJECT');
    expect(content).not.toContain('IFCWALL');
    expect(content).not.toContain('IFCBUILDINGSTOREY');
    expect(content).not.toContain('IFCRELAGGREGATES');
    expect(content).not.toContain('IFCRELCONTAINEDINSPATIALSTRUCTURE');
    expect(findDanglingRefs(content)).toEqual([]);
  });
});
