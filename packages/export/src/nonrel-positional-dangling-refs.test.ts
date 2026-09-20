/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A dangling-`#N` class `visible-only-dangling-refs.test.ts` and
 * `relationship-filter-gate.test.ts` do not cover: `writeSourceEntityLines`
 * (`step-source-iteration.ts`) only runs `filterHiddenRefsFromRelationshipLine`
 * when `effectiveRelType.startsWith('IFCREL')` or the type is in
 * `STYLE_RESCUE_TYPES`. A DIRECT positional attribute on a non-relationship
 * class that lists other entities — `IfcCostItem.CostValues` /
 * `.CostQuantities`, `IfcAppliedValue.Components` (and its one IFC4/IFC4X3
 * subtype `IfcCostValue`), `IfcPhysicalComplexQuantity.HasQuantities` — is
 * outside both branches, so `bim.store.removeEntity`
 * (`@ifc-lite/mutations`'s `store-editor.ts`) tombstoning an entity those
 * attributes name ships the referencing line with a `#N` that has no `#N=`
 * defining line, on a plain full export with no `visibleOnly` and no
 * `includeGeometry:false` involved.
 *
 * Two guards sit beside the repro, because the fix must extend the filter's
 * REACH (which line types it runs on) without widening its CRITERION (which
 * ids `isOmittedFromOutput` calls omitted):
 *  - a ref that was already dangling in the SOURCE file (an id this store
 *    never had) is not this export's to repair and must ship unchanged;
 *  - a ref a product's `Representation`/`ObjectPlacement` slot names is
 *    documented (`step-omission-predicates.ts`) as never reached by this
 *    filter at all, `includeGeometry:false` or not, and must stay that way.
 */

import { describe, expect, it } from 'vitest';
import { asSourceBytes, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { StepExporter } from './step-exporter.js';

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

type MockEntityRef = {
  expressId: number;
  type: string;
  byteOffset: number;
  byteLength: number;
  lineNumber: number;
};

/** Same shape as `relationship-filter-gate.test.ts`'s file-parsed store. */
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
  for (const m of content.matchAll(/(^|\n)#(\d+)\s*=/g)) defined.add(+m[2]);
  const dangling = new Set<number>();
  for (const m of content.matchAll(/#(\d+)/g)) {
    const id = +m[1];
    if (!defined.has(id)) dangling.add(id);
  }
  return [...dangling].sort((a, b) => a - b);
}

const COUNT_QTY = "#1=IFCQUANTITYCOUNT('CountQ',$,$,3.);\n";
const AREA_QTY = "#3=IFCQUANTITYAREA('AreaQ',$,$,9.);\n";
const COST_ITEM = "#2=IFCCOSTITEM('0cost000000000000000A',$,'CI',$,$,$,$,(#1,#3),$);\n";

describe('a session deletion dangles a non-IFCREL positional reference', () => {
  it('drops the deleted quantity from IfcCostItem.CostQuantities on a plain full export', () => {
    const store = buildParsedStore([
      [1, 'IFCQUANTITYCOUNT', COUNT_QTY],
      [2, 'IFCCOSTITEM', COST_ITEM],
      [3, 'IFCQUANTITYAREA', AREA_QTY],
    ]);

    // No `visibleOnly`, no `includeGeometry:false` — the only exclusion is
    // this session's own deletion, same isolation as
    // `relationship-filter-gate.test.ts`'s overlay-deletion case.
    const view = new MutablePropertyView(null, 'nonrel-test');
    view.deleteEntity(1);

    const content = decode(new StepExporter(store, view).export({ schema: 'IFC4' }).content);

    expect(content).not.toContain('#1=IFCQUANTITYCOUNT');
    expect(findDanglingRefs(content)).toEqual([]);
    // Rewritten, not withheld: the surviving #3 keeps CostItem's own line.
    expect(content).toMatch(/#2=IFCCOSTITEM\([^)]*\(#3\)/);
  });

  it('EXPLICIT CHOICE: deleting every CostQuantities member (OPTIONAL LIST) narrows to $, not ()', () => {
    // `IfcCostItem.CostQuantities` is `OPTIONAL LIST [1:?]`
    // (`IFC4_ADD2_TC1.exp`): an empty list is schema-invalid the same way an
    // empty `IFCREL*` set is, exactly as `filterHiddenRefsFromRelationshipLine`'s
    // own doc warns — "a SET attribute of a real IFC schema is never empty...
    // it is a second, different kind of invalid file". `()` reproduces that
    // invalid file. The attribute being OPTIONAL means the schema HAS a valid
    // spelling for "none": `$`. Withholding the whole record (the shared
    // function's response) reintroduces the cascading regression this branch
    // exists to avoid — some OTHER entity may still name this IfcCostItem.
    const store = buildParsedStore([
      [1, 'IFCQUANTITYCOUNT', COUNT_QTY],
      [2, 'IFCCOSTITEM', "#2=IFCCOSTITEM('0cost000000000000000D',$,'CI',$,$,$,$,(#1));\n"],
    ]);

    const view = new MutablePropertyView(null, 'empty-list-test');
    view.deleteEntity(1);

    const content = decode(new StepExporter(store, view).export({ schema: 'IFC4' }).content);

    expect(content).not.toContain('#1=IFCQUANTITYCOUNT');
    expect(findDanglingRefs(content)).toEqual([]);
    expect(content).toMatch(/#2=IFCCOSTITEM\('0cost000000000000000D',\$,'CI',\$,\$,\$,\$,\$\);/);
    expect(content).not.toContain('()');
  });

  it('EXPLICIT CHOICE: deleting every HasQuantities member (MANDATORY SET, not OPTIONAL) ships the dangling ref, does not withhold', () => {
    // `IfcPhysicalComplexQuantity.HasQuantities` is `SET [1:?] OF
    // IfcPhysicalQuantity`, NOT `OPTIONAL` (`IFC4_ADD2_TC1.exp` and
    // `IFC2X3_TC1.exp` agree). There is no valid spelling for "none left":
    // `()` violates the [1:?] lower bound exactly like the CostQuantities
    // case, and `$` is equally invalid on a mandatory attribute — STEP has no
    // "omitted" token for a slot the schema requires present. Both
    // alternatives ship an invalid file, and withholding the whole
    // IfcPhysicalComplexQuantity cascades the same way the OwnerHistory case
    // did. The only non-harmful choice left is to leave the slot exactly as
    // `upstream/main` emits it: unfiltered, dangling ref intact.
    const store = buildParsedStore([
      [1, 'IFCQUANTITYCOUNT', COUNT_QTY],
      [2, 'IFCPHYSICALCOMPLEXQUANTITY', "#2=IFCPHYSICALCOMPLEXQUANTITY('CQ',$,(#1),'Disc',$,$);\n"],
    ]);

    const view = new MutablePropertyView(null, 'mandatory-set-test');
    view.deleteEntity(1);

    const content = decode(new StepExporter(store, view).export({ schema: 'IFC4' }).content);

    expect(content).not.toContain('#1=IFCQUANTITYCOUNT');
    // Left untouched: `(#1)` ships exactly as main emits it, dangling.
    expect(content).toMatch(/#2=IFCPHYSICALCOMPLEXQUANTITY\('CQ',\$,\(#1\),'Disc',\$,\$\);/);
    expect(findDanglingRefs(content)).toEqual([1]);
  });
});

describe('the extended reach does not widen the criterion', () => {
  it('EXEMPTION: a reference dangling in the source file itself (never deleted) still ships unchanged', () => {
    // #99 was never in this store at all — a pre-existing dangling ref in
    // somebody else's file, out of scope per `step-omission-predicates.ts`.
    //
    // The deletion of #1 is load-bearing, not scene-setting. `mayNameOmittedRefs`
    // is `pass.allowedEntityIds !== null || pass.overlayActive || excludeGeometry
    // || hasAnyUnreadableSourceRef()`, so a plain export with no view and no
    // options leaves every disjunct false and gates this whole branch — and the
    // `IFCREL*` one — off before any of it runs. Asserting #99 survives THERE
    // would pass with the feature deleted. Deleting #1 turns the overlay on, so
    // the narrowing genuinely executes on this line, and #99 surviving it is
    // then evidence about the criterion rather than about the gate.
    const store = buildParsedStore([
      [1, 'IFCQUANTITYCOUNT', COUNT_QTY],
      [2, 'IFCCOSTITEM', "#2=IFCCOSTITEM('0cost000000000000000B',$,'CI',$,$,$,$,$,(#1,#99));\n"],
    ]);

    const view = new MutablePropertyView(null, 'source-dangling-test');
    view.deleteEntity(1);

    const content = decode(new StepExporter(store, view).export({ schema: 'IFC4' }).content);

    // The session's own deletion is scrubbed...
    expect(content).not.toContain('#1=IFCQUANTITYCOUNT');
    // ...while the ref that arrived dangling is left exactly as it came in.
    expect(content).toMatch(/#2=IFCCOSTITEM\([^)]*\(#99\)\);/);
    expect(findDanglingRefs(content)).toEqual([99]);
  });

  it('EXEMPTION: a Representation ref dropped by includeGeometry:false still ships unchanged', () => {
    // The documented exempt case: `Representation`/`ObjectPlacement` on a
    // product are not `IFCREL*` and not in the new positional-reach set, so
    // this filter must never reach them, `includeGeometry:false` or not.
    const store = buildParsedStore([
      [5, 'IFCCARTESIANPOINT', '#5=IFCCARTESIANPOINT((0.,0.,0.));\n'],
      [6, 'IFCAXIS2PLACEMENT3D', '#6=IFCAXIS2PLACEMENT3D(#5,$,$);\n'],
      [7, 'IFCLOCALPLACEMENT', '#7=IFCLOCALPLACEMENT($,#6);\n'],
      [8, 'IFCWALL', "#8=IFCWALL('0wall00000000000000000',$,'W',$,$,#7,$,$);\n"],
    ]);

    const content = decode(new StepExporter(store).export({ schema: 'IFC4', includeGeometry: false }).content);

    // The geometry entities are correctly omitted from their own lines...
    expect(content).not.toContain('#6=IFCAXIS2PLACEMENT3D');
    // ...but the wall's ObjectPlacement slot still names the now-absent #7
    // unfiltered, exactly as `step-omission-predicates.ts` documents (80
    // dangling refs before and after on `AB22.ifc`).
    expect(content).toContain('#8=IFCWALL');
    expect(content).toContain('#7');
  });
});

/**
 * The withhold half of `filterHiddenRefsFromRelationshipLine` is wrong for
 * `NONREL_REF_LIST_TYPES`. `IfcCostItem` is `IfcRoot -> ... -> IfcObject ->
 * IfcControl -> IfcCostItem`, so its OWN slot 2 (`OwnerHistory`) is a bare,
 * single-valued `#N`, not a list — exactly the shape
 * `filterHiddenRefsFromRelationshipLine`'s bare-ref rule withholds the WHOLE
 * line for (its only exception is `IFCRELCONNECTSSTRUCTURALMEMBER`'s
 * `ConditionCoordinateSystem`, which does not apply here). Reusing that rule
 * unmodified for a non-relationship type turns "one dangling `#N`" into
 * "the referencing entity's own line vanishes", which is worse: every OTHER
 * entity that names the now-vanished `IfcCostItem` starts dangling too. On
 * `upstream/main` (which never touches this line at all) the `OwnerHistory`
 * ref simply ships dangling, same as any other untouched positional
 * attribute — this class is exempt, not fixed, by design.
 */
describe('the non-rel filter must not withhold on a BARE ref (regression guard)', () => {
  it('a deleted OwnerHistory must not vanish the whole IfcCostItem line', () => {
    const store = buildParsedStore([
      [1, 'IFCOWNERHISTORY', '#1=IFCOWNERHISTORY($,$,$,$,$,$,$,0);\n'],
      [2, 'IFCCOSTITEM', "#2=IFCCOSTITEM('0cost000000000000000C',#1,'CI',$,$,$,$,$);\n"],
    ]);

    const view = new MutablePropertyView(null, 'bare-ref-test');
    view.deleteEntity(1);

    const content = decode(new StepExporter(store, view).export({ schema: 'IFC4' }).content);

    // The bug: `filterHiddenRefsFromRelationshipLine` sees the bare excluded
    // `#1` in OwnerHistory and returns `null`, so `#2=IFCCOSTITEM` never
    // reaches the output at all — a cascading regression against main, which
    // ships the line (with `#1` dangling) unconditionally.
    expect(content).toContain('#2=IFCCOSTITEM');
  });
});

/**
 * `IfcCostItem` is NOT the same shape in IFC2X3 as in IFC4: `IFC2X3_TC1.exp`
 * declares it `SUBTYPE OF (IfcControl)` with ZERO own attributes — neither
 * `CostValues` nor `CostQuantities` exists at all in that schema (they were
 * added in IFC4). Checked directly in the generated registry
 * (`@ifc-lite/parser`'s `ifc2x3/schema-registry.ts`): `IfcCostItem.attributes`
 * is `[]`, and `allAttributes` is exactly `GlobalId, OwnerHistory, Name,
 * Description, ObjectType` — none of them an aggregate. So a valid IFC2X3
 * `IFCCOSTITEM` line has no parenthesised entity-reference list at all, and
 * `narrowNonRelPositionalRefLists` — which only ever acts on a syntactically
 * parenthesised attribute — has nothing to touch. This is CONFIRMED here by
 * export, not just by reading the `.exp`: an IFC2X3-declared line with a
 * deleted OwnerHistory target ships completely unchanged, same as `main`.
 */
describe('IFC2X3: IfcCostItem has no CostValues/CostQuantities attributes at all', () => {
  it('an IFC2X3 IfcCostItem line is untouched by the non-rel filter (nothing to narrow)', () => {
    const store = buildParsedStore([
      [1, 'IFCOWNERHISTORY', '#1=IFCOWNERHISTORY($,$,$,$,$,$,$,0);\n'],
      // Exactly IFC2X3's 5 IfcCostItem slots: GlobalId, OwnerHistory, Name,
      // Description, ObjectType — no CostValues/CostQuantities slot exists.
      [2, 'IFCCOSTITEM', "#2=IFCCOSTITEM('0cost000000000000000E',#1,'CI',$,$);\n"],
    ]);
    (store as unknown as { schemaVersion: string }).schemaVersion = 'IFC2X3';

    const view = new MutablePropertyView(null, 'ifc2x3-test');
    view.deleteEntity(1);

    const content = decode(new StepExporter(store, view).export({ schema: 'IFC2X3' }).content);

    // Byte-identical source line apart from the deletion of #1's own line —
    // the OwnerHistory bare ref stays exactly as authored, dangling, same as
    // `upstream/main` (which never reaches this line at all).
    expect(content).toContain("#2=IFCCOSTITEM('0cost000000000000000E',#1,'CI',$,$);");
  });
});
