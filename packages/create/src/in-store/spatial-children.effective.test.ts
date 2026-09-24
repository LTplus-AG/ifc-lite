/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * In-store authoring walks read the session's effective model (#5249): real
 * parsed IFC, real `MutablePropertyView` + `StoreEditor`.
 *
 *  - Auto Spaces: a wall deleted this session is no longer a room divider,
 *    and a retype into a non-divider class takes it out too.
 *  - Space Sketch dedup: a space deleted this session is not "existing", and
 *    a space created this session (baked earlier) is, so baking again does
 *    not stack a duplicate room on it.
 *  - Duplicate: an association relationship deleted this session is not
 *    replayed onto the duplicate.
 */

import { describe, it, expect } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { extractWallSegmentsForStorey, existingSpaceFootprintsByStorey } from './extract-walls.js';
import { resolveDuplicateSource } from './resolve-source.js';
import { resolveSpatialAnchor } from './resolve-anchor.js';
import { addSpaceToStore } from './space.js';

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
#50=IFCWALL('0WALL0000000000000000',$,'W1',$,$,#20,#60,$,$);
#51=IFCWALL('0WALL0000000000000001',$,'W2',$,$,#20,#60,$,$);
#20=IFCLOCALPLACEMENT(#10,#21);
#21=IFCAXIS2PLACEMENT3D(#94,$,#95);
#94=IFCCARTESIANPOINT((0.,0.,0.));
#95=IFCDIRECTION((1.,0.,0.));
#60=IFCPRODUCTDEFINITIONSHAPE($,$,(#61));
#61=IFCSHAPEREPRESENTATION(#7,'Axis','Curve2D',(#62));
#62=IFCPOLYLINE((#63,#64));
#63=IFCCARTESIANPOINT((0.,0.));
#64=IFCCARTESIANPOINT((5.,0.));
#6=IFCSPACE('0SPACE000000000000000',$,'Room',$,$,#26,#66,$,.ELEMENT.,.INTERNAL.,$);
#26=IFCLOCALPLACEMENT(#10,#27);
#27=IFCAXIS2PLACEMENT3D(#96,$,#97);
#96=IFCCARTESIANPOINT((0.,0.,0.));
#97=IFCDIRECTION((1.,0.,0.));
#66=IFCPRODUCTDEFINITIONSHAPE($,$,(#67));
#67=IFCSHAPEREPRESENTATION(#7,'Body','SweptSolid',(#68));
#68=IFCEXTRUDEDAREASOLID(#69,#75,#76,3.);
#69=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#70);
#70=IFCPOLYLINE((#71,#72,#73,#74));
#71=IFCCARTESIANPOINT((1.,0.));
#72=IFCCARTESIANPOINT((3.,0.));
#73=IFCCARTESIANPOINT((3.,2.));
#74=IFCCARTESIANPOINT((1.,2.));
#75=IFCAXIS2PLACEMENT3D(#98,$,$);
#98=IFCCARTESIANPOINT((0.,0.,0.));
#76=IFCDIRECTION((0.,0.,1.));
#77=IFCRELAGGREGATES('0RELAGG0000000000000',$,$,$,#2,(#3));
#78=IFCRELAGGREGATES('0RELAGG0000000000001',$,$,$,#3,(#4));
#79=IFCRELCONTAINEDINSPATIALSTRUCTURE('0RELCONT000000000000',$,$,$,(#50,#51),#4);
#80=IFCRELAGGREGATES('0RELAGG0000000000002',$,$,$,#4,(#6));
#82=IFCPROPERTYSET('0PSET00000000000000000',$,'Pset_WallCommon',$,());
#83=IFCRELDEFINESBYPROPERTIES('0RELDEF000000000000000',$,$,$,(#50),#82);
ENDSEC;
END-ISO-10303-21;
`;

async function session() {
  const store: IfcDataStore = await new IfcParser().parseColumnar(new TextEncoder().encode(IFC).buffer);
  const view = new MutablePropertyView(store.properties ?? null, 'm');
  const editor = new StoreEditor(store, view);
  return { store, view, editor };
}

const dividers = (store: IfcDataStore, view: MutablePropertyView | undefined) =>
  extractWallSegmentsForStorey(store, 4, view).contributingWallIds.slice().sort((a, b) => a - b);

describe('in-store authoring over the edited model (#5249)', () => {
  it('Auto Spaces: a deleted or retyped-away wall is no longer a divider', async () => {
    const { store, view, editor } = await session();
    expect(dividers(store, view)).toEqual([50, 51]);
    editor.removeEntity(51);
    expect(dividers(store, view)).toEqual([50]);
    editor.setEntityType(50, 'IfcFurniture');
    expect(dividers(store, view)).toEqual([]);
  });

  it('Space Sketch dedup: a deleted space is not existing, a baked one is', async () => {
    const { store, view, editor } = await session();
    expect(existingSpaceFootprintsByStorey(store, view).get(4)).toHaveLength(1);

    editor.removeEntity(6);
    expect(existingSpaceFootprintsByStorey(store, view).has(4)).toBe(false);

    const anchor = resolveSpatialAnchor(store, 4, view);
    expect(anchor).not.toBeNull();
    addSpaceToStore(editor, anchor!, { Profile: 'rectangle', Position: [10, 10, 0], Width: 4, Depth: 3, Height: 2.8 });
    const baked = existingSpaceFootprintsByStorey(store, view).get(4);
    expect(baked, 'the space created this session counts as existing').toHaveLength(1);
  });

  it('Duplicate: a deleted association is not replayed onto the copy', async () => {
    const { store, editor } = await session();
    expect((resolveDuplicateSource(store, 50, editor).associations ?? []).map((a) => a.relatingExpressId)).toEqual([82]);
    editor.removeEntity(83);
    expect(resolveDuplicateSource(store, 50, editor).associations).toEqual([]);
  });

  it('Duplicate: an association created this session is replayed onto the copy', async () => {
    const { store, editor } = await session();
    const pset = editor.addEntity('IfcPropertySet', ['2PSET00000000000000000', null, 'Pset_Authored', null, []]).expressId;
    editor.addEntity('IfcRelDefinesByProperties', ['2RELDEF000000000000000', null, null, null, ['#50'], `#${pset}`]);
    const relating = (resolveDuplicateSource(store, 50, editor).associations ?? []).map((a) => a.relatingExpressId);
    expect(relating.sort((a, b) => a - b)).toEqual([82, pset]);
  });

  it('Duplicate: refuses a source deleted this session', async () => {
    const { store, editor } = await session();
    editor.removeEntity(50);
    expect(() => resolveDuplicateSource(store, 50, editor)).toThrow(/deleted/);
  });
});
