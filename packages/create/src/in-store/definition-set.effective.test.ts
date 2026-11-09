/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #7681 through the in-store authoring readers of
 * `IfcRelDefinesByProperties.RelatingPropertyDefinition`, which is an
 * `IfcPropertySetDefinitionSelect`: one reference, a bare set `(#a,#b)`, or the
 * typed `IFCPROPERTYSETDEFINITIONSET((#a,#b))`.
 *
 *  - Duplicate (`resolveDuplicateSource` + `duplicateInStore`) used to skip a
 *    set-linked relationship, so the copy lost every pset and qset on it.
 *  - Metadata clone treats a one-member set as the single definition it is,
 *    so a same-named set already on the piece is kept, not shared over.
 */

import { describe, it, expect } from 'vitest';
import { IfcParser, extractQuantitiesOnDemand, extractPropertiesOnDemand, propertyDefinitionRefsOfValue, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor, recordCompoundMutation, undoRecordedMutationOperations } from '@ifc-lite/mutations';
import { resolveDuplicateSource } from './resolve-source.js';
import { duplicateInStore } from './duplicate.js';
import { StepExporter } from '@ifc-lite/export';
import { QuantityType } from '@ifc-lite/data';
import { copyBatchInStore } from './copy-batch.js';
import { AnchorEntityReader } from './resolve-anchor.js';
import { asRef, refList } from './style-entity-reader.js';
import { cloneElementMetadata } from './edit/metadata-clone.js';

const IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0PROJECT000000000000',$,'Proj',$,$,$,$,(#7),#8);
#7=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#9,$);
#9=IFCAXIS2PLACEMENT3D(#90,$,$);
#90=IFCCARTESIANPOINT((0.,0.,0.));
#8=IFCUNITASSIGNMENT((#81));
#81=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#2=IFCSITE('0SITE0000000000000000',$,'Site',$,$,#11,$,$,.ELEMENT.,$,$,$,$,$);
#11=IFCLOCALPLACEMENT($,#12);
#12=IFCAXIS2PLACEMENT3D(#91,$,$);
#91=IFCCARTESIANPOINT((0.,0.,0.));
#3=IFCBUILDING('0BUILDING000000000000',$,'Bldg',$,$,#13,$,$,.ELEMENT.,$,$,$);
#13=IFCLOCALPLACEMENT(#11,#14);
#14=IFCAXIS2PLACEMENT3D(#92,$,$);
#92=IFCCARTESIANPOINT((0.,0.,0.));
#4=IFCBUILDINGSTOREY('0STOREY00000000000000',$,'Storey',$,$,#10,$,$,.ELEMENT.,0.);
#10=IFCLOCALPLACEMENT(#13,#15);
#15=IFCAXIS2PLACEMENT3D(#93,$,$);
#93=IFCCARTESIANPOINT((0.,0.,0.));
#50=IFCWALL('0WALL0000000000000050',$,'Single',$,$,#20,#60,$,$);
#51=IFCWALL('0WALL0000000000000051',$,'Bare',$,$,#20,#60,$,$);
#52=IFCWALL('0WALL0000000000000052',$,'Typed',$,$,#20,#60,$,$);
#53=IFCWALL('0WALL0000000000000053',$,'OneMember',$,$,#20,#60,$,$);
#54=IFCWALL('0WALL0000000000000054',$,'Piece',$,$,#20,#60,$,$);
#55=IFCWALL('0WALL0000000000000055',$,'StrayNumber',$,$,#20,#60,$,$);
#56=IFCWALL('0WALL0000000000000056',$,'NonDefinition',$,$,#20,#60,$,$);
#57=IFCWALL('0WALL0000000000000057',$,'OnlyStray',$,$,#20,#60,$,$);
#20=IFCLOCALPLACEMENT(#10,#21);
#21=IFCAXIS2PLACEMENT3D(#94,$,#95);
#94=IFCCARTESIANPOINT((0.,0.,0.));
#95=IFCDIRECTION((1.,0.,0.));
#60=IFCPRODUCTDEFINITIONSHAPE($,$,(#61));
#61=IFCSHAPEREPRESENTATION(#7,'Axis','Curve2D',(#62));
#62=IFCPOLYLINE((#63,#64));
#63=IFCCARTESIANPOINT((0.,0.));
#64=IFCCARTESIANPOINT((5.,0.));
#84=IFCRELAGGREGATES('0RELAGG0000000000003',$,$,$,#1,(#2));
#77=IFCRELAGGREGATES('0RELAGG0000000000000',$,$,$,#2,(#3));
#78=IFCRELAGGREGATES('0RELAGG0000000000001',$,$,$,#3,(#4));
#79=IFCRELCONTAINEDINSPATIALSTRUCTURE('0RELCONT000000000000',$,$,$,(#50,#51,#52,#53,#54,#55,#56,#57),#4);
#82=IFCPROPERTYSET('0PSET00000000000000082',$,'Pset_A',$,());
#83=IFCELEMENTQUANTITY('0QTO000000000000000083',$,'Qto_B',$,$,());
#85=IFCRELDEFINESBYPROPERTIES('0RELDEF000000000000085',$,$,$,(#50),#82);
#86=IFCRELDEFINESBYPROPERTIES('0RELDEF000000000000086',$,$,$,(#51),(#82,#83));
#87=IFCRELDEFINESBYPROPERTIES('0RELDEF000000000000087',$,$,$,(#52),IFCPROPERTYSETDEFINITIONSET((#82,#83)));
#88=IFCRELDEFINESBYPROPERTIES('0RELDEF000000000000088',$,$,$,(#53),IFCPROPERTYSETDEFINITIONSET((#82)));
#89=IFCRELDEFINESBYPROPERTIES('0RELDEF000000000000089',$,$,$,(#55),(#82,1500));
#90=IFCRELDEFINESBYPROPERTIES('0RELDEF000000000000090',$,$,$,(#56),(#82,#63,#83));
#91=IFCRELDEFINESBYPROPERTIES('0RELDEF000000000000091',$,$,$,(#57),(1500));
ENDSEC;
END-ISO-10303-21;
`;

async function session(source = IFC) {
  const store: IfcDataStore = await new IfcParser().parseColumnar(new TextEncoder().encode(source).buffer, { disableWorkerScan: true });
  const view = new MutablePropertyView(store.properties ?? null, 'm');
  const editor = new StoreEditor(store, view);
  return { store, view, editor };
}

describe('Duplicate over RelatingPropertyDefinition spellings (#7681)', () => {
  it.each([
    ['a single reference', 50, [82]],
    ['a bare set', 51, [82, 83]],
    ['a typed set', 52, [82, 83]],
    ['a one-member typed set', 53, [82]],
  ] as const)('replays %s onto the copy', async (_label, wall, definitions) => {
    const { store, view, editor } = await session();
    const source = resolveDuplicateSource(store, wall, editor);
    const defines = (source.associations ?? []).filter((a) => a.relType.toUpperCase() === 'IFCRELDEFINESBYPROPERTIES');
    expect(defines.map((a) => a.relatingExpressIds ?? [a.relatingExpressId])).toEqual([definitions]);

    const built = duplicateInStore(editor, source);
    const rel = view.getNewEntities().find((e) => e.expressId === built.associationRelIds[0]);
    expect(rel?.type.toUpperCase()).toBe('IFCRELDEFINESBYPROPERTIES');
    expect(rel?.attributes[4]).toEqual([`#${built.newId}`]);
    // `#N` for one definition, `(#a,#b)` for a set.
    expect(rel?.attributes[5]).toEqual(definitions.length === 1 ? `#${definitions[0]}` : definitions.map((id) => `#${id}`));
  });
});

describe('Duplicate over a malformed set (#7681)', () => {
  const definitionsOf = async (wall: number) => {
    const { store, editor } = await session();
    const source = resolveDuplicateSource(store, wall, editor);
    return (source.associations ?? [])
      .filter((a) => a.relType.toUpperCase() === 'IFCRELDEFINESBYPROPERTIES')
      .map((a) => a.relatingExpressIds ?? [a.relatingExpressId]);
  };

  it('a number that names no entity is not copied as a reference: (#82,1500)', async () => {
    expect(await definitionsOf(55)).toEqual([[82]]);
  });

  it('a member that is not a property definition is not copied: (#82,#63,#83)', async () => {
    // #63 is an IfcCartesianPoint.
    expect(await definitionsOf(56)).toEqual([[82, 83]]);
  });

  it('a set with no property definition at all is skipped as it was before sets were read', async () => {
    expect(await definitionsOf(57)).toEqual([]);
  });

  it('the copy never writes a dangling or wrong-typed reference', async () => {
    const { store, view, editor } = await session();
    const built = duplicateInStore(editor, resolveDuplicateSource(store, 55, editor));
    const rel = view.getNewEntities().find((e) => e.expressId === built.associationRelIds[0]);
    expect(rel?.attributes[5]).toBe('#82');
  });
});

describe('Metadata clone over RelatingPropertyDefinition spellings (#7681)', () => {
  const pieceHasOwnPsetA = async () => {
    const s = await session();
    s.editor.addPropertySet(54, 'Pset_A', [{ name: 'Own', type: 'LABEL', value: 'x' }]);
    return s;
  };

  it('a one-member set takes the named-set path: the piece keeps its own same-name set', async () => {
    const { store, view, editor } = await pieceHasOwnPsetA();
    // #88 is a one-member typed set holding Pset_A; the piece already has its own Pset_A.
    expect(cloneElementMetadata(store, view, editor, 53, [54]).relationshipsTouched).toBe(0);
  });

  it('a single reference behaves the same', async () => {
    const { store, view, editor } = await pieceHasOwnPsetA();
    expect(cloneElementMetadata(store, view, editor, 50, [54]).relationshipsTouched).toBe(0);
  });

  it('a multi-member set is still shared whole', async () => {
    const { store, view, editor } = await pieceHasOwnPsetA();
    expect(cloneElementMetadata(store, view, editor, 51, [54]).relationshipsTouched).toBe(1);
  });
});


for (const quantity of [false, true]) it(`#9296 a copied edited ${quantity ? 'quantity' : 'property'} in the second definition keeps its current value`, async () => {
  let source = IFC.replace("'Pset_A',$,());", "'Pset_A',$,(#96));")
    .replace("'Qto_B',$,$,());", "'Qto_B',$,$,(#97));")
    .replace('ENDSEC;\nEND-ISO', "#96=IFCPROPERTYSINGLEVALUE('Code',$,IFCLABEL('kept'),$);\n#97=IFCQUANTITYLENGTH('Length',$,$,5.,$);\nENDSEC;\nEND-ISO");
  if (!quantity) source = source.replace(/^#83=.*$/m, "#83=IFCPROPERTYSET('0PSET00000000000000083',$,'Pset_B',$,(#97));")
    .replace("#97=IFCQUANTITYLENGTH('Length',$,$,5.,$);", "#97=IFCPROPERTYSINGLEVALUE('Code',$,IFCLABEL('old'),$);");
  const { store, view, editor } = await session(source);
  view.setOnDemandExtractor(id => extractPropertiesOnDemand(store, id));
  view.setQuantityExtractor(id => extractQuantitiesOnDemand(store, id));
  if (quantity) view.setQuantity(51, 'Qto_B', 'Length', 23, QuantityType.Length);
  else view.setProperty(51, 'Pset_B', 'Code', 'effective');
  const copy = copyBatchInStore(store, editor, [51], [{ offset: [0, 2, 0] }])[0].copyId;
  const bytes = new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true }).content;
  const reopened = await new IfcParser().parseColumnar(bytes.slice().buffer, { disableWorkerScan: true });
  const reader = new AnchorEntityReader(reopened, null);
  const definitions = [...reader.ids('IFCRELDEFINESBYPROPERTIES')].flatMap(id => {
    const rel = reader.entity(id)!;
    return refList(rel.attributes[4]).includes(copy) ? propertyDefinitionRefsOfValue(rel.attributes[5], asRef).map(id => reader.entity(id)?.attributes[2]) : [];
  });
  expect(definitions.filter(name => name === (quantity ? 'Qto_B' : 'Pset_B'))).toHaveLength(1);
  if (quantity) expect(extractQuantitiesOnDemand(reopened, copy).find(set => set.name === 'Qto_B')?.quantities[0].value).toBe(23);
  else expect(extractPropertiesOnDemand(reopened, copy).find(set => set.name === 'Pset_B')?.properties[0].value).toBe('effective');
});

for (const quantity of [false, true]) for (const operation of ['shared', 'second', 'delete'] as const) it(`#9296 same-named ${quantity ? 'quantity' : 'property'} definitions retain ${operation} edits on copy and undo`, async () => {
  const name = quantity ? 'Qto_Same' : 'Pset_Same';
  const definitions = quantity
    ? `#82=IFCELEMENTQUANTITY('0QTO000000000000000082',$,'${name}',$,$,(#96));
#83=IFCELEMENTQUANTITY('0QTO000000000000000083',$,'${name}',$,$,(#97));
#96=IFCQUANTITYLENGTH('Length',$,$,5.,$);
#97=IFCQUANTITYLENGTH('${operation === 'second' ? 'Second' : 'Length'}',$,$,11.,$);`
    : `#82=IFCPROPERTYSET('0PSET00000000000000082',$,'${name}',$,(#96));
#83=IFCPROPERTYSET('0PSET00000000000000083',$,'${name}',$,(#97));
#96=IFCPROPERTYSINGLEVALUE('Code',$,IFCLABEL('first'),$);
#97=IFCPROPERTYSINGLEVALUE('${operation === 'second' ? 'Second' : 'Code'}',$,IFCLABEL('second'),$);`;
  const source = IFC.replace(/^#82=.*\n#83=.*$/m, definitions)
    .replace('(#51),(#82,#83)', '(#51),#82')
    .replace('ENDSEC;\nEND-ISO', "#198=IFCRELDEFINESBYPROPERTIES('0RELDEF000000000000198',$,$,$,(#51),#83);\nENDSEC;\nEND-ISO");
  const { store, view, editor } = await session(source);
  view.setOnDemandExtractor(id => extractPropertiesOnDemand(store, id));
  view.setQuantityExtractor(id => extractQuantitiesOnDemand(store, id));
  const member = operation === 'second' ? 'Second' : quantity ? 'Length' : 'Code';
  if (operation === 'delete') {
    if (quantity) view.deleteQuantity(51, name, member); else view.deleteProperty(51, name, member);
  } else if (quantity) view.setQuantity(51, name, member, 23, QuantityType.Length);
  else view.setProperty(51, name, member, 'edited');
  const history = view.getMutationCount();
  const copy = recordCompoundMutation(view, draft => copyBatchInStore(store, new StoreEditor(store, draft),
    [51], [{ offset: [0, 2, 0] }])[0].copyId);
  const output = new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true }).content;
  const reopened = await new IfcParser().parseColumnar(output.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
  for (const target of [copy, 51]) {
    const sets = quantity ? extractQuantitiesOnDemand(reopened, target) : extractPropertiesOnDemand(reopened, target);
    expect(sets.filter(set => set.name === name), 'each populated definition survives').toHaveLength(operation === 'delete' ? 1 : 2);
    const values = quantity
      ? extractQuantitiesOnDemand(reopened, target).filter(set => set.name === name).flatMap(set => set.quantities.map(member => member.value))
      : extractPropertiesOnDemand(reopened, target).filter(set => set.name === name).flatMap(set => set.properties.map(member => member.value));
    const expected = operation === 'delete' ? quantity ? [11] : ['second']
      : operation === 'second' ? quantity ? [5, 23] : ['first', 'edited'] : quantity ? [23, 11] : ['edited', 'second'];
    expect(values).toEqual(expected);
  }
  undoRecordedMutationOperations(view, 1, () => { throw new Error('The copy must be one compound'); });
  expect(view.getMutationCount()).toBe(history);
  const undone = await new IfcParser().parseColumnar(new StepExporter(store, view)
    .export({schema:'IFC4',applyMutations:true}).content.slice().buffer as ArrayBuffer,{disableWorkerScan:true});
  expect(undone.entities.getTypeName(copy)).toBe('Unknown');
});
