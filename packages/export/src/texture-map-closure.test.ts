/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it, expect } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { getEffectiveEntityIndex } from './effective-index.js';
import { collectStyleEntities } from './style-closure.js';

const source = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Texture inverse closure'),'2;1');
FILE_NAME('model.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#10=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.)));
#11=IFCTRIANGULATEDFACESET(#10,$,.F.,((1,2,3)),$);
#12=IFCTRIANGULATEDFACESET(#10,$,.F.,((1,2,3)),$);
#13=IFCIMAGETEXTURE(.T.,.T.,'DIFFUSE',$,$,'shared.png');
#14=IFCTEXTUREVERTEXLIST(((0.,0.),(1.,0.),(0.,1.)));
#15=IFCINDEXEDTRIANGLETEXTUREMAP((#13),#11,#14,((1,2,3)));
#16=IFCINDEXEDTRIANGLETEXTUREMAP((#13),#12,#14,((1,2,3)));
ENDSEC;
END-ISO-10303-21;`;
async function fixture() {
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(source).buffer);
  const view = new MutablePropertyView(null, 'model');
  const editor = new StoreEditor(store, view);
  const collect = (excluded = new Set<number>()) => {
    const index = getEffectiveEntityIndex(store, view, true);
    const closure = new Set([10, 11, 13]);
    collectStyleEntities(closure, store.source, { byId: index, byType: index.byType }, excluded);
    return closure;
  };
  return { view, editor, collect };
}

describe('inverse texture-map closure #4243', () => {
  it('retains UV maps by visible MappedTo geometry without rescuing hidden maps sharing images', async () => {
    const { collect } = await fixture();
    const closure = collect();
    expect(closure.has(15)).toBe(true);
    expect(closure.has(14)).toBe(true);
    expect(closure.has(12)).toBe(false);
    expect(closure.has(16)).toBe(false);
    expect(collect(new Set([15])).has(15)).toBe(false);
  });
  it('uses effective source retargets, tombstones and overlay-created map targets', async () => {
    const { view, editor, collect } = await fixture();
    view.setPositionalAttribute(15, 1, '#12');
    expect(collect().has(15)).toBe(false);
    const map = editor.addEntity('IfcIndexedTriangleTextureMap', [['#13'], '#11', '#14', [[1, 2, 3]]]);
    expect(collect().has(map.expressId)).toBe(true);
    view.setPositionalAttribute(map.expressId, 1, '#12');
    expect(collect().has(map.expressId)).toBe(false);
    editor.removeEntity(map.expressId);
    expect(collect().has(map.expressId)).toBe(false);
  });
});

// IfcTextureMap.MappedTo accepts every IfcFace subtype, not only literal IfcFace.
it('rescues a face-surface texture map through its EXPRESS MappedTo slot (#4243)', async () => {
  const data = source.replace('ENDSEC;\nEND-ISO-10303-21;', `
#30=IFCCARTESIANPOINT((0.,0.,0.));
#31=IFCCARTESIANPOINT((1.,0.,0.));
#32=IFCCARTESIANPOINT((0.,1.,0.));
#33=IFCPOLYLOOP((#30,#31,#32));
#34=IFCFACEOUTERBOUND(#33,.T.);
#35=IFCAXIS2PLACEMENT3D(#30,$,$);
#36=IFCPLANE(#35);
#40=IFCFACESURFACE((#34),#36,.T.);
#41=IFCFACESURFACE((#34),#36,.T.);
#50=IFCTEXTUREVERTEX((0.,0.));
#51=IFCTEXTUREVERTEX((1.,0.));
#52=IFCTEXTUREVERTEX((0.,1.));
#53=IFCTEXTUREMAP((#13),(#50,#51,#52),#40);
#54=IFCTEXTUREMAP((#13),(#50,#51,#52),#41);
ENDSEC;
END-ISO-10303-21;`);
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(data).buffer);
  const closure = new Set([13, 30, 31, 32, 33, 34, 35, 36, 40]);
  collectStyleEntities(closure, store.source, store.entityIndex);
  expect(closure.has(53)).toBe(true);
  expect(closure.has(50)).toBe(true);
  expect(closure.has(54)).toBe(false);
  expect(closure.has(41)).toBe(false);
});
