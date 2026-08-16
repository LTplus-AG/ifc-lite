/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression guard for a dangling-reference class confirmed on #2398: a
 * `visibleOnly` STEP export drops hidden products from the DATA section but
 * used to emit every `IFCREL*` record verbatim from the source bytes.
 * `IFCREL*` is an unconditional root in `getVisibleEntityIds` (relationships
 * reference products, never the other way round, so they must be roots for
 * psets/materials/types to stay reachable), and the source-iteration loop in
 * `step-exporter.ts` copies a source record's bytes with only retype /
 * attribute / positional mutations applied — nothing filtered a `#N` whose
 * target the closure had just excluded.
 *
 * The result was a file with `#N` references that have no `#N=` defining
 * line. `entity-iteration.ts` states this package's own position on that
 * shape: "STEP output with dangling `#`-references that strict viewers (e.g.
 * BIM Vision) reject, and that makes lenient viewers fall geometry back to
 * the origin".
 *
 * Fixed by `filterHiddenRefsFromRelationshipLine` (`reference-collector.ts`),
 * called from both entity-emission passes in `step-exporter.ts` right after a
 * relationship's line is otherwise ready to write: a hidden id is dropped
 * from a nested list attribute (`RelatedObjects`, `RelatedElements`, …), and
 * a relationship is withheld outright when a hidden id sits in a bare scalar
 * attribute (`RelatingSpace`, `RelatedOpeningElement`, …) or when dropping it
 * from a list would leave that list empty. One syntactic rule covers every
 * `IFCREL*` subtype, including `IFCRELVOIDSELEMENT`'s mirror case (hidden
 * opening, visible host) that `propagateOpeningExclusions` did not reach —
 * that function only deletes the relation when the RELATING element is
 * hidden.
 */

import { describe, expect, it } from 'vitest';
import { asSourceBytes, type IfcDataStore } from '@ifc-lite/parser';
import { StepExporter } from './step-exporter.js';

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

type MockEntityRef = {
  expressId: number;
  type: string;
  byteOffset: number;
  byteLength: number;
  lineNumber: number;
};

/** Same shape as `sourceless-store-export.test.ts`'s file-parsed store. */
function buildParsedStore(entries: Array<[number, string, string]>): IfcDataStore {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const byId = new Map<number, MockEntityRef>();
  const byType = new Map<string, number[]>();
  let offset = 0;

  for (const [id, type, text] of entries) {
    const encoded = encoder.encode(text);
    const upper = type.toUpperCase();
    byId.set(id, { expressId: id, type: upper, byteOffset: offset, byteLength: encoded.byteLength, lineNumber: 0 });
    if (!byType.has(upper)) byType.set(upper, []);
    byType.get(upper)!.push(id);
    parts.push(encoded);
    offset += encoded.byteLength;
  }

  const source = new Uint8Array(offset);
  let position = 0;
  for (const part of parts) {
    source.set(part, position);
    position += part.byteLength;
  }

  return {
    fileSize: offset,
    schemaVersion: 'IFC4',
    entityCount: entries.length,
    parseTime: 0,
    source: asSourceBytes(source),
    entityIndex: { byId, byType },
  } as unknown as IfcDataStore;
}

/** Every `#N` referenced in the output that has no `#N=` defining line. */
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

const PROJECT = "#1=IFCPROJECT('0proj0000000000000000',$,'P',$,$,$,$,$,$);\n";
const STOREY = "#2=IFCBUILDINGSTOREY('0stor0000000000000000',$,'S',$,$,$,$,$,$,0.);\n";

describe('visibleOnly does not emit dangling references to excluded products', () => {
  it('leaves the hidden wall in IfcRelContainedInSpatialStructure.RelatedElements', () => {
    const store = buildParsedStore([
      [1, 'IFCPROJECT', PROJECT],
      [2, 'IFCBUILDINGSTOREY', STOREY],
      [3, 'IFCWALL', "#3=IFCWALL('0walA0000000000000000',$,'KeptWall',$,$,$,$,$);\n"],
      [4, 'IFCWALL', "#4=IFCWALL('0walB0000000000000000',$,'HiddenWall',$,$,$,$,$);\n"],
      [21, 'IFCRELCONTAINEDINSPATIALSTRUCTURE', "#21=IFCRELCONTAINEDINSPATIALSTRUCTURE('0cont0000000000000000',$,$,$,(#3,#4),#2);\n"],
      [24, 'IFCRELAGGREGATES', "#24=IFCRELAGGREGATES('0aggr0000000000000000',$,$,$,#1,(#2));\n"],
    ]);

    const content = decode(new StepExporter(store).export({
      schema: 'IFC4',
      visibleOnly: true,
      hiddenEntityIds: new Set([4]),
    }).content);

    // The exclusion itself is correct and deliberate.
    expect(content).not.toContain('#4=IFCWALL');
    // The reference to it is not. Measured: the emitted line is
    // `#21=IFCRELCONTAINEDINSPATIALSTRUCTURE(...,(#3,#4),#2);` — `#4` dangles.
    expect(findDanglingRefs(content)).toEqual([]);
    // No dangling refs must come from REWRITING the list, not from
    // withholding #21 wholesale: the relationship survives with the kept
    // wall still contained and only the hidden one dropped.
    const rel21 = content.match(/^#21=IFCRELCONTAINEDINSPATIALSTRUCTURE\((.*)\);$/m);
    expect(rel21).not.toBeNull();
    expect(rel21![1]).toContain('(#3)');
    expect(rel21![1]).not.toContain('#4');
  });

  it('leaves the hidden wall in IfcRelDefinesByProperties / IfcRelDefinesByType RelatedObjects', () => {
    const store = buildParsedStore([
      [1, 'IFCPROJECT', PROJECT],
      [2, 'IFCBUILDINGSTOREY', STOREY],
      [4, 'IFCWALL', "#4=IFCWALL('0walB0000000000000000',$,'HiddenWall',$,$,$,$,$);\n"],
      [10, 'IFCPROPERTYSET', "#10=IFCPROPERTYSET('0pset0000000000000000',$,'Pset_WallCommon',$,(#11));\n"],
      [11, 'IFCPROPERTYSINGLEVALUE', "#11=IFCPROPERTYSINGLEVALUE('Reference',$,IFCTEXT('R1'),$);\n"],
      [12, 'IFCWALLTYPE', "#12=IFCWALLTYPE('0wtyp0000000000000000',$,'WT',$,$,$,$,$,$,.STANDARD.);\n"],
      [22, 'IFCRELDEFINESBYPROPERTIES', "#22=IFCRELDEFINESBYPROPERTIES('0rdbp0000000000000000',$,$,$,(#4),#10);\n"],
      [23, 'IFCRELDEFINESBYTYPE', "#23=IFCRELDEFINESBYTYPE('0rdbt0000000000000000',$,$,$,(#4),#12);\n"],
    ]);

    const content = decode(new StepExporter(store).export({
      schema: 'IFC4',
      visibleOnly: true,
      hiddenEntityIds: new Set([4]),
    }).content);

    expect(content).not.toContain('#4=IFCWALL');
    expect(findDanglingRefs(content)).toEqual([]);
  });

  it('leaves the hidden space in IfcRelSpaceBoundary.RelatingSpace', () => {
    const store = buildParsedStore([
      [1, 'IFCPROJECT', PROJECT],
      [2, 'IFCBUILDINGSTOREY', STOREY],
      [3, 'IFCWALL', "#3=IFCWALL('0walA0000000000000000',$,'KeptWall',$,$,$,$,$);\n"],
      [6, 'IFCSPACE', "#6=IFCSPACE('0spac0000000000000000',$,'HiddenSpace',$,$,$,$,$,$,$);\n"],
      [25, 'IFCRELSPACEBOUNDARY', "#25=IFCRELSPACEBOUNDARY('0rsbd0000000000000000',$,$,$,#6,#3,$,.PHYSICAL.,.EXTERNAL.);\n"],
    ]);

    const content = decode(new StepExporter(store).export({
      schema: 'IFC4',
      visibleOnly: true,
      hiddenEntityIds: new Set([6]),
    }).content);

    expect(content).not.toContain('#6=IFCSPACE');
    expect(findDanglingRefs(content)).toEqual([]);
  });

  it('leaves a hidden OPENING in IfcRelVoidsElement — the mirror of the case propagateOpeningExclusions covers', () => {
    // `propagateOpeningExclusions` deletes the relation from `roots` when the
    // RELATING element is hidden. Here the relating wall is visible and the
    // RELATED opening is what the caller hid, so that branch never fires.
    const store = buildParsedStore([
      [1, 'IFCPROJECT', PROJECT],
      [2, 'IFCBUILDINGSTOREY', STOREY],
      [3, 'IFCWALL', "#3=IFCWALL('0walA0000000000000000',$,'VisibleWall',$,$,$,$,$);\n"],
      [5, 'IFCOPENINGELEMENT', "#5=IFCOPENINGELEMENT('0open0000000000000000',$,'HiddenOpening',$,$,$,$,$);\n"],
      [20, 'IFCRELVOIDSELEMENT', "#20=IFCRELVOIDSELEMENT('0void0000000000000000',$,$,$,#3,#5);\n"],
    ]);

    const content = decode(new StepExporter(store).export({
      schema: 'IFC4',
      visibleOnly: true,
      hiddenEntityIds: new Set([5]),
    }).content);

    expect(content).not.toContain('#5=IFCOPENINGELEMENT');
    expect(findDanglingRefs(content)).toEqual([]);
  });

  it('leaves the non-isolated wall in the containment relation under isolation', () => {
    const store = buildParsedStore([
      [1, 'IFCPROJECT', PROJECT],
      [2, 'IFCBUILDINGSTOREY', STOREY],
      [3, 'IFCWALL', "#3=IFCWALL('0walA0000000000000000',$,'Isolated',$,$,$,$,$);\n"],
      [4, 'IFCWALL', "#4=IFCWALL('0walB0000000000000000',$,'Other',$,$,$,$,$);\n"],
      [21, 'IFCRELCONTAINEDINSPATIALSTRUCTURE', "#21=IFCRELCONTAINEDINSPATIALSTRUCTURE('0cont0000000000000000',$,$,$,(#3,#4),#2);\n"],
    ]);

    const content = decode(new StepExporter(store).export({
      schema: 'IFC4',
      visibleOnly: true,
      hiddenEntityIds: new Set<number>(),
      isolatedEntityIds: new Set([3]),
    }).content);

    expect(content).not.toContain('#4=IFCWALL');
    expect(findDanglingRefs(content)).toEqual([]);
  });
});

/**
 * #2548: hiding an element must also keep its associated data out of the
 * file, not just its own defining line and geometry. Before the fix, the
 * `IFCRELDEFINESBYPROPERTIES` root was emitted unconditionally and the
 * closure walked THROUGH it into the pset and its atoms — which are not
 * products, so were never in `excludeIds` — shipping the hidden element's
 * property values as an orphaned line nothing in the output names.
 *
 * `getVisibleEntityIds` treating every `IFCREL*` as an unconditional root is
 * still correct — relationships must stay reachable so a VISIBLE element's
 * psets, materials, types etc. survive. The gap was that the closure walk
 * did not check whether a relationship's own line would survive
 * `filterHiddenRefsFromRelationshipLine` before using it as a bridge into
 * its target. A relationship whose every subject is hidden now propagates no
 * forward references at all, so its target becomes unreachable and is
 * dropped from the closure — the same test this file already applies to
 * `IFCREL*` lines themselves, run one step earlier.
 */
describe('visibleOnly does not ship a hidden element’s associated data (#2548)', () => {
  it('drops Pset content reachable only from the hidden wall', () => {
    const store = buildParsedStore([
      [1, 'IFCPROJECT', PROJECT],
      [4, 'IFCWALL', "#4=IFCWALL('0walB0000000000000000',$,'HiddenWall',$,$,$,$,$);\n"],
      [10, 'IFCPROPERTYSET', "#10=IFCPROPERTYSET('0pset0000000000000000',$,'Pset_Custom',$,(#11));\n"],
      [11, 'IFCPROPERTYSINGLEVALUE', "#11=IFCPROPERTYSINGLEVALUE('Cost',$,IFCTEXT('CONFIDENTIAL'),$);\n"],
      [22, 'IFCRELDEFINESBYPROPERTIES', "#22=IFCRELDEFINESBYPROPERTIES('0rdbp0000000000000000',$,$,$,(#4),#10);\n"],
    ]);

    const content = decode(new StepExporter(store).export({
      schema: 'IFC4',
      visibleOnly: true,
      hiddenEntityIds: new Set([4]),
    }).content);

    expect(content).not.toContain('#4=IFCWALL');
    expect(content).not.toContain('CONFIDENTIAL');
    expect(content).not.toContain('IFCPROPERTYSET');
    expect(findDanglingRefs(content)).toEqual([]);
  });

  it('drops quantity sets, the type object, material and classification associated only with the hidden wall', () => {
    const store = buildParsedStore([
      [1, 'IFCPROJECT', PROJECT],
      [4, 'IFCWALL', "#4=IFCWALL('0walB0000000000000000',$,'HiddenWall',$,$,$,$,$);\n"],
      [13, 'IFCELEMENTQUANTITY', "#13=IFCELEMENTQUANTITY('0qset0000000000000000',$,'Qto_WallBaseQuantities',$,(#14));\n"],
      [14, 'IFCQUANTITYLENGTH', "#14=IFCQUANTITYLENGTH('Length',$,$,42.);\n"],
      [23, 'IFCRELDEFINESBYPROPERTIES', "#23=IFCRELDEFINESBYPROPERTIES('0rdbq0000000000000000',$,$,$,(#4),#13);\n"],
      [12, 'IFCWALLTYPE', "#12=IFCWALLTYPE('0wtyp0000000000000000',$,'SecretWallType',$,$,$,$,$,$,.STANDARD.);\n"],
      [24, 'IFCRELDEFINESBYTYPE', "#24=IFCRELDEFINESBYTYPE('0rdbt0000000000000000',$,$,$,(#4),#12);\n"],
      [15, 'IFCMATERIAL', "#15=IFCMATERIAL('SecretMaterial',$,$);\n"],
      [25, 'IFCRELASSOCIATESMATERIAL', "#25=IFCRELASSOCIATESMATERIAL('0rdam0000000000000000',$,$,$,(#4),#15);\n"],
      [16, 'IFCCLASSIFICATION', "#16=IFCCLASSIFICATION($,$,$,'SecretClassificationSource');\n"],
      [17, 'IFCCLASSIFICATIONREFERENCE', "#17=IFCCLASSIFICATIONREFERENCE($,'SEC.001','SecretClassRef',#16,$,$);\n"],
      [26, 'IFCRELASSOCIATESCLASSIFICATION', "#26=IFCRELASSOCIATESCLASSIFICATION('0rdac0000000000000000',$,$,$,(#4),#17);\n"],
    ]);

    const content = decode(new StepExporter(store).export({
      schema: 'IFC4',
      visibleOnly: true,
      hiddenEntityIds: new Set([4]),
    }).content);

    expect(content).not.toContain('#4=IFCWALL');
    expect(content).not.toContain('IFCELEMENTQUANTITY');
    expect(content).not.toContain('IFCWALLTYPE');
    expect(content).not.toContain('IFCMATERIAL');
    expect(content).not.toContain('SecretClassificationSource');
    expect(findDanglingRefs(content)).toEqual([]);
  });

  it('control: a VISIBLE wall’s pset, material and type still ship, filter is not over-broad', () => {
    const store = buildParsedStore([
      [1, 'IFCPROJECT', PROJECT],
      [3, 'IFCWALL', "#3=IFCWALL('0walA0000000000000000',$,'KeptWall',$,$,$,$,$);\n"],
      [10, 'IFCPROPERTYSET', "#10=IFCPROPERTYSET('0pset0000000000000000',$,'Pset_Custom',$,(#11));\n"],
      [11, 'IFCPROPERTYSINGLEVALUE', "#11=IFCPROPERTYSINGLEVALUE('Cost',$,IFCTEXT('VISIBLE_COST'),$);\n"],
      [22, 'IFCRELDEFINESBYPROPERTIES', "#22=IFCRELDEFINESBYPROPERTIES('0rdbp0000000000000000',$,$,$,(#3),#10);\n"],
      [15, 'IFCMATERIAL', "#15=IFCMATERIAL('VisibleMaterial',$,$);\n"],
      [25, 'IFCRELASSOCIATESMATERIAL', "#25=IFCRELASSOCIATESMATERIAL('0rdam0000000000000000',$,$,$,(#3),#15);\n"],
    ]);

    const content = decode(new StepExporter(store).export({
      schema: 'IFC4',
      visibleOnly: true,
      hiddenEntityIds: new Set<number>(),
    }).content);

    expect(content).toContain('#3=IFCWALL');
    expect(content).toContain('VISIBLE_COST');
    expect(content).toContain('VisibleMaterial');
    expect(findDanglingRefs(content)).toEqual([]);
  });

  it('keeps a pset shared by a visible AND a hidden wall — the relationship line drops the hidden member, not the pset', () => {
    const store = buildParsedStore([
      [1, 'IFCPROJECT', PROJECT],
      [3, 'IFCWALL', "#3=IFCWALL('0walA0000000000000000',$,'KeptWall',$,$,$,$,$);\n"],
      [4, 'IFCWALL', "#4=IFCWALL('0walB0000000000000000',$,'HiddenWall',$,$,$,$,$);\n"],
      [10, 'IFCPROPERTYSET', "#10=IFCPROPERTYSET('0pset0000000000000000',$,'Pset_Shared',$,(#11));\n"],
      [11, 'IFCPROPERTYSINGLEVALUE', "#11=IFCPROPERTYSINGLEVALUE('Reference',$,IFCTEXT('SHARED'),$);\n"],
      [22, 'IFCRELDEFINESBYPROPERTIES', "#22=IFCRELDEFINESBYPROPERTIES('0rdbp0000000000000000',$,$,$,(#3,#4),#10);\n"],
    ]);

    const content = decode(new StepExporter(store).export({
      schema: 'IFC4',
      visibleOnly: true,
      hiddenEntityIds: new Set([4]),
    }).content);

    expect(content).not.toContain('#4=IFCWALL');
    expect(content).toContain('#3=IFCWALL');
    expect(content).toContain('SHARED');
    expect(findDanglingRefs(content)).toEqual([]);
  });

  // CodeRabbit finding on #2637: the closure's own `extractRelationshipRefGroups`
  // parser (`reference-collector.ts`) only pushed MATCHED `#N` items into a
  // list group, so a list holding one hidden ref alongside a non-reference
  // item collapsed to "every remaining id excluded" and blocked bridging.
  // `filterHiddenRefsFromRelationshipLine` — the function that actually
  // decides whether the relationship's OWN line survives — treats that same
  // non-reference item as an unconditional survivor (it only ever drops an
  // `#N` item), so the line was never going to be withheld. The two
  // predicates disagreeing dropped a visible pset from the closure the
  // emitted line still names. Purely SYNTACTIC (this file's own header notes
  // the fix applies to every `IFCREL*` shape, not just schema-realistic
  // ones), so the inline `IFCLABEL('X')` list member below does not need to
  // be a real IFC attribute value — only a non-`#N` list item.
  it('bridges into the pset when a hidden ref sits in a list alongside a non-reference survivor', () => {
    const store = buildParsedStore([
      [1, 'IFCPROJECT', PROJECT],
      [4, 'IFCWALL', "#4=IFCWALL('0walB0000000000000000',$,'HiddenWall',$,$,$,$,$);\n"],
      [10, 'IFCPROPERTYSET', "#10=IFCPROPERTYSET('0pset0000000000000000',$,'Pset_Custom',$,(#11));\n"],
      [11, 'IFCPROPERTYSINGLEVALUE', "#11=IFCPROPERTYSINGLEVALUE('Cost',$,IFCTEXT('SURVIVOR_COST'),$);\n"],
      [22, 'IFCRELDEFINESBYPROPERTIES', "#22=IFCRELDEFINESBYPROPERTIES('0rdbp0000000000000000',$,$,$,(#4,IFCLABEL('X')),#10);\n"],
    ]);

    const content = decode(new StepExporter(store).export({
      schema: 'IFC4',
      visibleOnly: true,
      hiddenEntityIds: new Set([4]),
    }).content);

    expect(content).not.toContain('#4=IFCWALL');
    expect(content).toContain('SURVIVOR_COST');
    expect(content).toContain('#10=IFCPROPERTYSET');
    expect(findDanglingRefs(content)).toEqual([]);
  });
});
