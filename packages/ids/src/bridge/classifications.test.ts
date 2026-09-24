/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Non-rooted resources (IfcMaterial, IfcProfileDef, …) cannot carry
 * `IfcRelAssociatesClassification` — that relation targets `IfcRoot`
 * subtypes only. The only way such a resource gets a classification is
 * `IfcExternalReferenceRelationship` pointing at it from
 * `RelatedResourceObjects`, walked by
 * `appendExternalReferenceClassifications` in ./classifications.ts.
 *
 * Before this file, nothing exercised that walk anywhere in the package
 * (confirmed by grepping the suite for
 * `resolveClassifications|ExternalReferenceRelationship|IFCCLASSIFICATIONREFERENCE`
 * across every `*.test.ts` — zero hits). A broken walk would silently
 * under- or over-match classification facets against materials.
 */

import { describe, it, expect } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { createDataAccessor } from './data-accessor.js';

async function accessorFor(ifc: string) {
  const store = await new IfcParser().parseColumnar(
    new TextEncoder().encode(ifc).buffer,
    { disableWorkerScan: true },
  );
  return createDataAccessor(store);
}

const HEADER = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;`;
const FOOTER = `ENDSEC;
END-ISO-10303-21;`;

describe('resolveClassifications: IfcExternalReferenceRelationship walk for non-rooted resources', () => {
  it('resolves a material classified through IfcExternalReferenceRelationship', async () => {
    const ifc = `${HEADER}
#10=IFCMATERIAL('Concrete C30/37',$,$);
#20=IFCEXTERNALREFERENCERELATIONSHIP($,$,#21,(#10));
#21=IFCCLASSIFICATIONREFERENCE($,'Pr_20_93_08','Concrete',#22,$,$);
#22=IFCCLASSIFICATION($,$,$,'Uniclass 2015',$,$,$);
${FOOTER}`;
    const a = await accessorFor(ifc);
    const classifications = a.getClassifications(10);
    expect(classifications).toEqual([
      { system: 'Uniclass 2015', value: 'Pr_20_93_08', name: 'Concrete' },
    ]);
  });

  it('yields nothing for a resource with no IfcExternalReferenceRelationship (negative control)', async () => {
    const ifc = `${HEADER}
#10=IFCMATERIAL('Uncoated Material',$,$);
${FOOTER}`;
    const a = await accessorFor(ifc);
    expect(a.getClassifications(10)).toEqual([]);
  });

  it('walks a multi-hop reference chain and exposes both the leaf and the parent code', async () => {
    // Leaf reference #21 ('25.10.25') points to an intermediate reference
    // #23 ('25.10'), which points to the terminal IfcClassification #22.
    // A requirement against the parent code '25.10' must still match a
    // material classified at the leaf '25.10.25' (this is exactly the
    // EF_25_10 / EF_25_10_25 case documented on resolveClassifications).
    const ifc = `${HEADER}
#10=IFCMATERIAL('Steel S355',$,$);
#20=IFCEXTERNALREFERENCERELATIONSHIP($,$,#21,(#10));
#21=IFCCLASSIFICATIONREFERENCE($,'25.10.25','Structural steel',#23,$,$);
#23=IFCCLASSIFICATIONREFERENCE($,'25.10','Steel',#22,$,$);
#22=IFCCLASSIFICATION($,$,$,'Uniclass 2015',$,$,$);
${FOOTER}`;
    const a = await accessorFor(ifc);
    const classifications = a.getClassifications(10);
    expect(classifications).toEqual([
      { system: 'Uniclass 2015', value: '25.10.25', name: 'Structural steel' },
      { system: 'Uniclass 2015', value: '25.10', name: 'Structural steel' },
    ]);
  });

  it('terminates on a cyclic reference chain without hanging or duplicating, and marks it unresolved (#5290)', async () => {
    // #21 references #23, #23 references back to #21 — no IfcClassification
    // is ever reached, so `system` stays undefined, but the cycle guard
    // must stop the walk after each id is visited once. #5290: a cycle
    // never legitimately terminates (unlike a `ReferencedSource` that is
    // genuinely omitted), so the primary record is now marked `unresolved`
    // rather than silently reading as a confident empty system.
    const ifc = `${HEADER}
#10=IFCMATERIAL('Cyclic Material',$,$);
#20=IFCEXTERNALREFERENCERELATIONSHIP($,$,#21,(#10));
#21=IFCCLASSIFICATIONREFERENCE($,'A','RefA',#23,$,$);
#23=IFCCLASSIFICATIONREFERENCE($,'B','RefB',#21,$,$);
${FOOTER}`;
    const a = await accessorFor(ifc);
    const classifications = a.getClassifications(10);
    // Exactly one IfcExternalReferenceRelationship touches #10, so exactly
    // one ClassRecord is produced regardless of how many nodes the cycle
    // visits — a broken guard would either hang (infinite loop) or, if the
    // node were re-added to the output list on each revisit, duplicate.
    expect(classifications).toEqual([
      { system: '', value: 'A', name: 'RefA', unresolved: true },
      { system: '', value: 'B', name: 'RefA' },
    ]);
  });

  it('marks the record unresolved when the chain\'s ReferencedSource is dangling (#5290)', async () => {
    // #21's ReferencedSource (#999) does not exist in the file. The walk
    // could previously only leave `system: undefined` -- flattened by
    // `resolveClassifications` to a confident empty system, indistinguishable
    // from a classification that genuinely has none.
    const ifc = `${HEADER}
#10=IFCMATERIAL('Broken Chain Material',$,$);
#20=IFCEXTERNALREFERENCERELATIONSHIP($,$,#21,(#10));
#21=IFCCLASSIFICATIONREFERENCE($,'A','RefA',#999,$,$);
${FOOTER}`;
    const a = await accessorFor(ifc);
    const classifications = a.getClassifications(10);
    expect(classifications).toEqual([
      { system: '', value: 'A', name: 'RefA', unresolved: true },
    ]);
  });

  it('marks the record unresolved when ReferencedSource names an entity of an unexpected type (#5290)', async () => {
    const ifc = `${HEADER}
#10=IFCMATERIAL('Broken Chain Material',$,$);
#20=IFCEXTERNALREFERENCERELATIONSHIP($,$,#21,(#10));
#21=IFCCLASSIFICATIONREFERENCE($,'A','RefA',#22,$,$);
#22=IFCMATERIAL('Not A Classification',$,$);
${FOOTER}`;
    const a = await accessorFor(ifc);
    const classifications = a.getClassifications(10);
    expect(classifications).toEqual([
      { system: '', value: 'A', name: 'RefA', unresolved: true },
    ]);
  });

  it('control: a ReferencedSource omitted entirely ($) is a legitimate chain end -- NOT marked unresolved', async () => {
    const ifc = `${HEADER}
#10=IFCMATERIAL('Terse Chain Material',$,$);
#20=IFCEXTERNALREFERENCERELATIONSHIP($,$,#21,(#10));
#21=IFCCLASSIFICATIONREFERENCE($,'A','RefA',$,$,$);
${FOOTER}`;
    const a = await accessorFor(ifc);
    const classifications = a.getClassifications(10);
    expect(classifications).toEqual([
      { system: '', value: 'A', name: 'RefA' },
    ]);
  });
});

/**
 * #5249: the external-reference walk enumerated the parsed type index, so a
 * relationship deleted this session still classified the material, and one
 * created this session was invisible. The overlay here is the structural
 * shape both a live `MutablePropertyView` and the IDS worker's snapshot
 * provide.
 */
describe('resolveClassifications: external references over the edited model (#5249)', () => {
  const IFC = `${HEADER}
#10=IFCMATERIAL('Concrete C30/37',$,$);
#11=IFCMATERIAL('Steel S355',$,$);
#20=IFCEXTERNALREFERENCERELATIONSHIP($,$,#21,(#10));
#21=IFCCLASSIFICATIONREFERENCE($,'Pr_20_93_08','Concrete',#22,$,$);
#22=IFCCLASSIFICATION($,$,$,'Uniclass 2015',$,$,$);
${FOOTER}`;

  async function withOverlay(deleted: number[], created: Array<{ expressId: number; type: string; attributes: unknown[] }>) {
    const store = await new IfcParser().parseColumnar(new TextEncoder().encode(IFC).buffer, { disableWorkerScan: true });
    const tombstones = new Set(deleted);
    return createDataAccessor(store, undefined, {
      isDeleted: (id) => tombstones.has(id),
      getNewEntities: () => created,
    });
  }

  it('a relationship deleted this session no longer classifies the material', async () => {
    const a = await withOverlay([20], []);
    expect(a.getClassifications(10)).toEqual([]);
  });

  it('a relationship created this session classifies its material, through source and created references alike', async () => {
    const a = await withOverlay([], [
      // Plain strings, as a StoreEditor authors them (the serializer quotes).
      { expressId: 30, type: 'IfcClassificationReference', attributes: [null, 'Pr_20_76', 'Steel', '#22', null, null] },
      { expressId: 31, type: 'IfcExternalReferenceRelationship', attributes: [null, null, '#30', ['#11']] },
    ]);
    expect(a.getClassifications(11)).toEqual([
      { system: 'Uniclass 2015', value: 'Pr_20_76', name: 'Steel' },
    ]);
    // The source classification is untouched.
    expect(a.getClassifications(10)).toEqual([
      { system: 'Uniclass 2015', value: 'Pr_20_93_08', name: 'Concrete' },
    ]);
  });

  it('a classification reference deleted this session leaves the material unclassified', async () => {
    const a = await withOverlay([21], []);
    expect(a.getClassifications(10)).toEqual([]);
  });

  it('a chain link deleted this session marks the classification unresolved', async () => {
    const a = await withOverlay([22], []);
    expect(a.getClassifications(10)).toEqual([
      { system: '', value: 'Pr_20_93_08', name: 'Concrete', unresolved: true },
    ]);
  });

  it('an authored string is the literal value, not a STEP token to un-quote', async () => {
    const a = await withOverlay([], [
      { expressId: 30, type: 'IfcClassificationReference', attributes: [null, "'Pr_20_76'", 'Steel', '#22', null, null] },
      { expressId: 31, type: 'IfcExternalReferenceRelationship', attributes: [null, null, '#30', ['#11']] },
    ]);
    // serializeStepValue writes this string as the literal 'Pr_20_76' with its
    // quotes, so that is the value IDS must see.
    expect(a.getClassifications(11)).toEqual([
      { system: 'Uniclass 2015', value: "'Pr_20_76'", name: 'Steel' },
    ]);
  });

  it('builds the overlay snapshot once per accessor, not once per classification read', async () => {
    const store = await new IfcParser().parseColumnar(new TextEncoder().encode(IFC).buffer, { disableWorkerScan: true });
    let copies = 0;
    const accessor = createDataAccessor(store, undefined, {
      isDeleted: () => false,
      getNewEntities: () => { copies++; return []; },
    });
    accessor.getClassifications(10);
    const afterFirst = copies;
    for (let i = 0; i < 5; i++) accessor.getClassifications(10);
    accessor.getClassifications(11);
    expect(copies, 'later reads reuse the snapshot').toBe(afterFirst);
  });

  it('a typed authored value is data, never re-read as a #ref or $ token', async () => {
    const a = await withOverlay([], [
      { expressId: 30, type: 'IfcClassificationReference', attributes: [null, { typed: { type: 'IfcIdentifier', value: '#22' } }, 'Steel', '#22', null, null] },
      { expressId: 31, type: 'IfcExternalReferenceRelationship', attributes: [null, null, '#30', ['#11']] },
    ]);
    expect(a.getClassifications(11)).toEqual([
      { system: 'Uniclass 2015', value: '#22', name: 'Steel' },
    ]);
  });

  it('an authored typed-label value is unwrapped', async () => {
    const a = await withOverlay([], [
      { expressId: 30, type: 'IfcClassificationReference', attributes: [null, { typed: { type: 'IfcIdentifier', value: 'Pr_20_76' } }, 'Steel', '#22', null, null] },
      { expressId: 31, type: 'IfcExternalReferenceRelationship', attributes: [null, null, '#30', ['#11']] },
    ]);
    expect(a.getClassifications(11)).toEqual([
      { system: 'Uniclass 2015', value: 'Pr_20_76', name: 'Steel' },
    ]);
  });
});
