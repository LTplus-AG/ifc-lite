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

  it('drops the deleted member from IfcPhysicalComplexQuantity.HasQuantities while a survivor keeps the list', () => {
    // The all-members-deleted case below leaves a mandatory slot untouched;
    // this survivor case proves the type is actually reached and narrowed.
    const store = buildParsedStore([
      [1, 'IFCQUANTITYCOUNT', COUNT_QTY],
      [2, 'IFCPHYSICALCOMPLEXQUANTITY', "#2=IFCPHYSICALCOMPLEXQUANTITY('CQ',$,(#1,#3),'Disc',$,$);\n"],
      [3, 'IFCQUANTITYAREA', AREA_QTY],
    ]);

    const view = new MutablePropertyView(null, 'hasquantities-partial-test');
    view.deleteEntity(1);

    const content = decode(new StepExporter(store, view).export({ schema: 'IFC4' }).content);

    expect(content).not.toContain('#1=IFCQUANTITYCOUNT');
    expect(findDanglingRefs(content)).toEqual([]);
    // Rewritten, not withheld: the surviving #3 keeps the record's own line.
    expect(content).toMatch(/#2=IFCPHYSICALCOMPLEXQUANTITY\('CQ',\$,\(#3\),'Disc',\$,\$\);/);
  });

  it('EXPLICIT CHOICE: deleting every HasQuantities member (MANDATORY SET, not OPTIONAL) ships the dangling ref, does not withhold', () => {
    // A mandatory SET [1:?] has no valid empty spelling, so it stays unchanged.
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

/**
 * `IfcAppliedValue` and its one IFC4/IFC4X3 subtype `IfcCostValue` both
 * carry a `Components : OPTIONAL LIST [1:?] OF IfcAppliedValue` — checked
 * directly in `IFC4_ADD2_TC1.exp`:
 *
 *   ENTITY IfcAppliedValue
 *    SUPERTYPE OF (ONEOF (IfcCostValue));
 *     Name : OPTIONAL IfcLabel;
 *     ... (7 more OPTIONAL attributes) ...
 *     ArithmeticOperator : OPTIONAL IfcArithmeticOperatorEnum;
 *     Components : OPTIONAL LIST [1:?] OF IfcAppliedValue;
 *
 *   ENTITY IfcCostValue
 *    SUBTYPE OF (IfcAppliedValue);
 *   END_ENTITY;
 *
 * `IfcCostValue` declares ZERO own attributes (confirmed in the generated
 * registry, `@ifc-lite/parser`'s `schema-registry.ts`:
 * `IfcCostValue.attributes` is `[]`), so `Components` is INHERITED at the
 * same slot index — position 10 (`Name`=1 ... `ArithmeticOperator`=9,
 * `Components`=10) — for both the `IFCAPPLIEDVALUE` and `IFCCOSTVALUE`
 * tokens: neither type is `SUBTYPE OF (IfcRoot)`, so there is no
 * `GlobalId`/`OwnerHistory` prefix shifting the slot, and `IfcAppliedValue`
 * is not declared `ABSTRACT SUPERTYPE`, so `IFCAPPLIEDVALUE` itself is a
 * legal concrete line, not only `IFCCOSTVALUE`.
 */
describe('IfcAppliedValue / IfcCostValue.Components (own attribute, inherited by IfcCostValue)', () => {
  const UNIT = '#1=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(1.),#9);\n';
  const OTHER_VALUE = "#3=IFCAPPLIEDVALUE($,$,$,$,$,$,$,$,$,$);\n";

  it.each(['IFCAPPLIEDVALUE', 'IFCCOSTVALUE'])('drops the deleted member from %s.Components on a plain full export', (token) => {
    const line = `#2=${token}($,$,$,$,$,$,$,$,$,(#1,#3));\n`;
    const store = buildParsedStore([
      [1, 'IFCAPPLIEDVALUE', OTHER_VALUE.replace('#3=', '#1=')],
      [2, token, line],
      [3, 'IFCAPPLIEDVALUE', OTHER_VALUE],
    ]);

    const view = new MutablePropertyView(null, `${token}-components-test`);
    view.deleteEntity(1);

    const content = decode(new StepExporter(store, view).export({ schema: 'IFC4' }).content);

    expect(content).not.toContain('#1=IFCAPPLIEDVALUE');
    expect(findDanglingRefs(content)).toEqual([]);
    // Rewritten, not withheld: the surviving #3 keeps the record's own line.
    expect(content).toMatch(new RegExp(`#2=${token}\\([^)]*\\(#3\\)`));
  });

  it.each(['IFCAPPLIEDVALUE', 'IFCCOSTVALUE'])(
    'EXPLICIT CHOICE: deleting every %s.Components member (OPTIONAL LIST) narrows to $, not ()',
    (token) => {
      // `Components` is `OPTIONAL LIST [1:?]` on `IfcAppliedValue` itself
      // (`IFC4_ADD2_TC1.exp`) and inherited unchanged onto `IfcCostValue`
      // (which declares no own attributes) — the schema has a valid
      // spelling for "none of these": `$`, not the invalid `()`.
      const line = `#2=${token}($,$,$,$,$,$,$,$,$,(#1));\n`;
      const store = buildParsedStore([
        [1, 'IFCAPPLIEDVALUE', OTHER_VALUE.replace('#3=', '#1=')],
        [2, token, line],
      ]);

      const view = new MutablePropertyView(null, `${token}-empty-components-test`);
      view.deleteEntity(1);

      const content = decode(new StepExporter(store, view).export({ schema: 'IFC4' }).content);

      expect(content).not.toContain('#1=IFCAPPLIEDVALUE');
      expect(findDanglingRefs(content)).toEqual([]);
      expect(content).toMatch(new RegExp(`#2=${token}\\(\\$,\\$,\\$,\\$,\\$,\\$,\\$,\\$,\\$,\\$\\);`));
      expect(content).not.toContain('()');
    },
  );

  it.each(['IFCAPPLIEDVALUE', 'IFCCOSTVALUE'])(
    'a deleted UnitBasis (bare ref, slot 4) must not vanish the whole %s line',
    (token) => {
      // `UnitBasis : OPTIONAL IfcMeasureWithUnit` — a bare, single-valued
      // attribute at slot 4, not a list. Same shape as the file's existing
      // `IfcCostItem.OwnerHistory` regression guard: a bare excluded ref on
      // a `NONREL_REF_LIST_TYPES` member must be left dangling, unfiltered,
      // never made to withhold the whole record.
      const line = `#2=${token}($,$,$,#1,$,$,$,$,$,$);\n`;
      const store = buildParsedStore([
        [1, 'IFCMEASUREWITHUNIT', UNIT],
        [2, token, line],
      ]);

      const view = new MutablePropertyView(null, `${token}-bare-unitbasis-test`);
      view.deleteEntity(1);

      const content = decode(new StepExporter(store, view).export({ schema: 'IFC4' }).content);

      // The bug this guards: if the bare-ref-withholds rule were reused
      // unmodified for this type, `#2=...` would never reach the output.
      expect(content).toContain(`#2=${token}`);
      expect(content).toMatch(new RegExp(`#2=${token}\\(\\$,\\$,\\$,#1,`));
      expect(findDanglingRefs(content)).toEqual([1]);
    },
  );
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

    expect(content).toContain("#2=IFCCOSTITEM('0cost000000000000000E',#1,'CI',$,$);");
  });
});

/**
 * #5181: `IfcPropertySet.HasProperties` and `IfcElementQuantity.Quantities`
 * are both `SET [1:?] OF <entity>` on non-`IFCREL*` classes — precisely the
 * shape `NONREL_REF_LIST_TYPES` exists for, but outside the original
 * hand-kept four-entry set (#5066). Now covered because
 * `nonrel-ref-list-types.ts` derives the set from the generated schema
 * registries rather than hand-enumerating it (see that file's doc for how
 * the derivation is scoped down from every qualifying attribute to a safe
 * subset).
 *
 * Each pair below follows the same two-case shape already established for
 * `IfcPhysicalComplexQuantity.HasQuantities`: a PARTIAL deletion (so
 * narrowing is attributable — an all-members-deleted case on a MANDATORY
 * set is vacuous, because both "reached" and "not reached" leave the slot
 * dangling), then the EXPLICIT CHOICE that emptying a MANDATORY `[1:?]` set
 * to `()` is a different invalid file, so it must stay dangling rather than
 * become `()`.
 */
describe('#5181: IfcPropertySet.HasProperties (derived, not hand-kept)', () => {
  const PROP_A = "#1=IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.F.),$);\n";
  const PROP_B = "#3=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('R60'),$);\n";

  it('drops the deleted member from IfcPropertySet.HasProperties while a survivor keeps the list', () => {
    const store = buildParsedStore([
      [1, 'IFCPROPERTYSINGLEVALUE', PROP_A],
      [2, 'IFCPROPERTYSET', "#2=IFCPROPERTYSET('0pset000000000000000A',$,'Pset_X',$,(#1,#3));\n"],
      [3, 'IFCPROPERTYSINGLEVALUE', PROP_B],
    ]);

    const view = new MutablePropertyView(null, 'propertyset-partial-test');
    view.deleteEntity(1);

    const content = decode(new StepExporter(store, view).export({ schema: 'IFC4' }).content);

    expect(content).not.toContain('#1=IFCPROPERTYSINGLEVALUE');
    expect(findDanglingRefs(content)).toEqual([]);
    // Rewritten, not withheld: the surviving #3 keeps the pset's own line.
    expect(content).toMatch(/#2=IFCPROPERTYSET\('0pset000000000000000A',\$,'Pset_X',\$,\(#3\)\);/);
  });

  it('EXPLICIT CHOICE: deleting every HasProperties member (MANDATORY SET, not OPTIONAL) ships the dangling ref, does not withhold', () => {
    const store = buildParsedStore([
      [1, 'IFCPROPERTYSINGLEVALUE', PROP_A],
      [2, 'IFCPROPERTYSET', "#2=IFCPROPERTYSET('0pset000000000000000B',$,'Pset_Y',$,(#1));\n"],
    ]);

    const view = new MutablePropertyView(null, 'propertyset-mandatory-test');
    view.deleteEntity(1);

    const content = decode(new StepExporter(store, view).export({ schema: 'IFC4' }).content);

    expect(content).not.toContain('#1=IFCPROPERTYSINGLEVALUE');
    // Left untouched: `(#1)` ships exactly as main emits it, dangling — `()`
    // would violate the `[1:?]` lower bound, and `$` would claim the
    // attribute is optional when the schema declares it mandatory.
    expect(content).toMatch(/#2=IFCPROPERTYSET\('0pset000000000000000B',\$,'Pset_Y',\$,\(#1\)\);/);
    expect(findDanglingRefs(content)).toEqual([1]);
    expect(content).not.toContain('()');
  });
});

describe('#5181: IfcElementQuantity.Quantities (derived, not hand-kept)', () => {
  it('drops the deleted member from IfcElementQuantity.Quantities while a survivor keeps the list', () => {
    const store = buildParsedStore([
      [1, 'IFCQUANTITYCOUNT', COUNT_QTY],
      [2, 'IFCELEMENTQUANTITY', "#2=IFCELEMENTQUANTITY('0qset000000000000000A',$,'Qto_X',$,$,(#1,#3));\n"],
      [3, 'IFCQUANTITYAREA', AREA_QTY],
    ]);

    const view = new MutablePropertyView(null, 'elementquantity-partial-test');
    view.deleteEntity(1);

    const content = decode(new StepExporter(store, view).export({ schema: 'IFC4' }).content);

    expect(content).not.toContain('#1=IFCQUANTITYCOUNT');
    expect(findDanglingRefs(content)).toEqual([]);
    // Rewritten, not withheld: the surviving #3 keeps the qset's own line.
    expect(content).toMatch(/#2=IFCELEMENTQUANTITY\('0qset000000000000000A',\$,'Qto_X',\$,\$,\(#3\)\);/);
  });

  it('EXPLICIT CHOICE: deleting every Quantities member (MANDATORY SET, not OPTIONAL) ships the dangling ref, does not withhold', () => {
    const store = buildParsedStore([
      [1, 'IFCQUANTITYCOUNT', COUNT_QTY],
      [2, 'IFCELEMENTQUANTITY', "#2=IFCELEMENTQUANTITY('0qset000000000000000B',$,'Qto_Y',$,$,(#1));\n"],
    ]);

    const view = new MutablePropertyView(null, 'elementquantity-mandatory-test');
    view.deleteEntity(1);

    const content = decode(new StepExporter(store, view).export({ schema: 'IFC4' }).content);

    expect(content).not.toContain('#1=IFCQUANTITYCOUNT');
    expect(content).toMatch(/#2=IFCELEMENTQUANTITY\('0qset000000000000000B',\$,'Qto_Y',\$,\$,\(#1\)\);/);
    expect(findDanglingRefs(content)).toEqual([1]);
    expect(content).not.toContain('()');
  });
});

/**
 * #5181: a type joins `NONREL_REF_LIST_TYPES` on ONE qualifying `[1:?]`
 * attribute, but narrowing rewrites every parenthesised slot on the line.
 * `IfcFillAreaStyleTiles` qualifies through `Tiles : SET [1:?] OF
 * IfcStyledItem` and also carries `TilingPattern : LIST [2:2] OF IfcVector`.
 * Each slot must be held to its OWN lower bound: narrowing `TilingPattern`
 * to one vector would swap one dangling ref for a different invalid file.
 */
describe("#5181: narrowing honours each slot's own lower bound", () => {
  const TILES_ENTRIES: Array<[number, string, string]> = [
    [1, 'IFCDIRECTION', '#1=IFCDIRECTION((1.,0.));\n'],
    [2, 'IFCDIRECTION', '#2=IFCDIRECTION((0.,1.));\n'],
    [3, 'IFCVECTOR', '#3=IFCVECTOR(#1,1.);\n'],
    [4, 'IFCVECTOR', '#4=IFCVECTOR(#2,1.);\n'],
    [5, 'IFCSTYLEDITEM', "#5=IFCSTYLEDITEM($,(#9),'A');\n"],
    [6, 'IFCSTYLEDITEM', "#6=IFCSTYLEDITEM($,(#9),'B');\n"],
    [7, 'IFCFILLAREASTYLETILES', '#7=IFCFILLAREASTYLETILES((#3,#4),(#5,#6),1.);\n'],
  ];

  it('leaves a LIST [2:2] TilingPattern untouched rather than narrowing it to one member', () => {
    const view = new MutablePropertyView(null, 'tiles-pattern-test');
    view.deleteEntity(3);

    const content = decode(new StepExporter(buildParsedStore(TILES_ENTRIES), view).export({ schema: 'IFC4' }).content);

    expect(content).not.toContain('#3=IFCVECTOR');
    expect(content).toContain('#7=IFCFILLAREASTYLETILES((#3,#4),(#5,#6),1.);');
  });

  it('still narrows the SET [1:?] Tiles list on the same line', () => {
    const view = new MutablePropertyView(null, 'tiles-tiles-test');
    view.deleteEntity(6);

    const content = decode(new StepExporter(buildParsedStore(TILES_ENTRIES), view).export({ schema: 'IFC4' }).content);

    expect(content).not.toContain('#6=IFCSTYLEDITEM');
    expect(content).toContain('#7=IFCFILLAREASTYLETILES((#3,#4),(#5),1.);');
  });
});
