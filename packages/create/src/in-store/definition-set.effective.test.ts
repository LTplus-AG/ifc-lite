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
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { resolveDuplicateSource } from './resolve-source.js';
import { duplicateInStore } from './duplicate.js';
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
#79=IFCRELCONTAINEDINSPATIALSTRUCTURE('0RELCONT000000000000',$,$,$,(#50,#51,#52,#53,#54),#4);
#82=IFCPROPERTYSET('0PSET00000000000000082',$,'Pset_A',$,());
#83=IFCELEMENTQUANTITY('0QTO000000000000000083',$,'Qto_B',$,$,());
#85=IFCRELDEFINESBYPROPERTIES('0RELDEF000000000000085',$,$,$,(#50),#82);
#86=IFCRELDEFINESBYPROPERTIES('0RELDEF000000000000086',$,$,$,(#51),(#82,#83));
#87=IFCRELDEFINESBYPROPERTIES('0RELDEF000000000000087',$,$,$,(#52),IFCPROPERTYSETDEFINITIONSET((#82,#83)));
#88=IFCRELDEFINESBYPROPERTIES('0RELDEF000000000000088',$,$,$,(#53),IFCPROPERTYSETDEFINITIONSET((#82)));
ENDSEC;
END-ISO-10303-21;
`;

async function session() {
  const store: IfcDataStore = await new IfcParser().parseColumnar(new TextEncoder().encode(IFC).buffer, { disableWorkerScan: true });
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
