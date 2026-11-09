/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from 'vitest';
import { EntityExtractor, IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { readOwnPlacementFrame } from './placement-frame.js';
import { buildRelatingChildrenIndex, createOverlayLookup } from './spatial-children.js';

const IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0PROJECT000000000000',$,'Proj',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#11,$);
#3=IFCUNITASSIGNMENT((#4));
#4=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#10=IFCLOCALPLACEMENT($,#11);
#11=IFCAXIS2PLACEMENT3D(#12,$,$);
#12=IFCCARTESIANPOINT((1.,2.,0.));
#13=IFCCARTESIANPOINT((5.,7.,0.));
ENDSEC;
END-ISO-10303-21;`;

describe('placement frames through a live overlay (#5249)', () => {
  it('follows edited placement links and refuses deleted entities', async () => {
    const store = await new IfcParser().parseColumnar(new TextEncoder().encode(IFC).buffer);
    const extractor = new EntityExtractor(store.source);
    const view = new MutablePropertyView(null, 'm');

    expect(readOwnPlacementFrame(store, extractor, view, 10)?.origin).toEqual([1, 2]);
    view.setPositionalAttribute(11, 0, '#13');
    expect(readOwnPlacementFrame(store, extractor, view, 10)?.origin).toEqual([5, 7]);
    view.deleteEntity(13);
    expect(readOwnPlacementFrame(store, extractor, view, 10)).toBeNull();
    view.deleteEntity(10);
    expect(readOwnPlacementFrame(store, extractor, view, 10)).toBeNull();
  });
});

it('placement and spatial reads avoid enumerating unrelated creations #8452', async () => {
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(IFC).buffer);
  const extractor = new EntityExtractor(store.source), view = new MutablePropertyView(null, 'scale');
  view.setExpressIdWatermark(100);
  for (let i = 0; i < 5000; i++) view.createEntity('IfcCartesianPoint', [[i, 0, 0]]);
  const point = view.createEntity('IfcCartesianPoint', [[8, 9, 0]]);
  const axis = view.createEntity('IfcAxis2Placement3D', [`#${point.expressId}`, null, null]);
  const placement = view.createEntity('IfcLocalPlacement', [null, `#${axis.expressId}`]);
  view.createEntity('IfcRelAggregates', ['guid', null, null, null, '#1', [`#${placement.expressId}`]]);
  const enumerations = vi.spyOn(view, 'getNewEntities');
  try {
    expect(readOwnPlacementFrame(store, extractor, view, placement.expressId)?.origin).toEqual([8, 9]);
    const lookup = createOverlayLookup(view);
    expect(buildRelatingChildrenIndex(store, extractor, lookup, 'IFCRELAGGREGATES', 4, 5).get(1)).toEqual([placement.expressId]);
    expect(enumerations).not.toHaveBeenCalled();
  } finally { enumerations.mockRestore(); }
});
