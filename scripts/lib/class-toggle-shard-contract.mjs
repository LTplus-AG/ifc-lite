/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5409: a class the viewer hides as a WHOLE class never reaches the
 * GPU-instanced shard.
 *
 * The shard carries an entity id and a colour per occurrence and no class, and
 * every class toggle in the viewer (Spaces, Openings, Terrain & context, ...)
 * filters the FLAT meshes by `ifcType`. An opaque, repeated opening therefore
 * rode the shard and ignored the Openings toggle. The Rust partition keeps
 * those classes flat (`CLASS_TOGGLED_TYPES` in
 * `rust/wasm-bindings/src/api/gpu_meshes/batch_partition.rs`).
 *
 * That list and the viewer's table (`typeVisibilityFilter.ts`) are two
 * statements of one set in two languages, so the fixture here is BUILT from
 * the viewer's table, imported straight from its TypeScript source: a class
 * added to the viewer and not to Rust fails this contract. Each class gets
 * eight opaque occurrences of one shared face set, the shape that instances,
 * and an `IfcWall` group of the same shape is the control that proves the
 * fixture does instance at all.
 */

import assert from 'node:assert/strict';
import { decodeInstancedShard } from '../../packages/geometry/dist/packed-instanced-decoder.js';

const GROUP = 8;

/** IFC4 attribute tails after `(GlobalId,$,Name,$,$,Placement,Representation`. */
const TAILS = {
  IfcSpace: ',$,.ELEMENT.,.SPACE.,$',
  IfcSpatialZone: ',$,.NOTDEFINED.',
  IfcOpeningElement: ',$,.OPENING.',
  IfcOpeningStandardCase: ',$,.OPENING.',
  IfcVirtualElement: ',$',
  IfcSite: ',$,.ELEMENT.,$,$,$,$,$',
  IfcGeographicElement: ',$,.NOTDEFINED.',
  IfcAnnotation: '',
  IfcWall: ',$,.NOTDEFINED.',
};

function fixture(classes) {
  const lines = [];
  let id = 1000;
  const owners = new Map();
  for (const cls of classes) {
    const tail = TAILS[cls];
    if (tail === undefined) throw new Error(`no IFC4 attribute tail for ${cls}: add one to TAILS`);
    for (let i = 0; i < GROUP; i++) {
      const eid = id++;
      owners.set(eid, cls);
      lines.push(`#${eid}=${cls.toUpperCase()}('${String(eid).padStart(22, '0')}',$,'${cls}',$,$,#5,#15${tail});`);
    }
  }
  const source = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Class toggle shard witness'),'2;1');
FILE_NAME('class-toggle.ifc','2026-09-24T00:00:00',('Test'),('Test'),'ifc-lite','ifc-lite','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCCARTESIANPOINT((0.,0.,0.));
#2=IFCDIRECTION((0.,0.,1.));
#3=IFCDIRECTION((1.,0.,0.));
#4=IFCAXIS2PLACEMENT3D(#1,#2,#3);
#5=IFCLOCALPLACEMENT($,#4);
#6=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,0.00001,#4,$);
#7=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#8=IFCUNITASSIGNMENT((#7));
#9=IFCPROJECT('0000000000000000000001',$,'Project',$,$,$,$,(#6),#8);
#12=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.),(0.,0.,1.)));
#13=IFCTRIANGULATEDFACESET(#12,$,.T.,((1,2,3),(1,2,4),(1,4,3),(2,3,4)),$);
#14=IFCSHAPEREPRESENTATION(#6,'Body','Tessellation',(#13));
#15=IFCPRODUCTDEFINITIONSHAPE($,$,(#14));
#16=IFCCOLOURRGB($,0.5,0.5,0.5);
#17=IFCSURFACESTYLERENDERING(#16,$,$,$,$,$,$,$,.FLAT.);
#18=IFCSURFACESTYLE('Opaque',.BOTH.,(#17));
#19=IFCSTYLEDITEM(#13,(#18),$);
${lines.join('\n')}
ENDSEC;
END-ISO-10303-21;
`;
  return { bytes: new TextEncoder().encode(source), owners };
}

function partition(IfcAPI, bytes) {
  const api = new IfcAPI();
  let result;
  try {
    const pre = api.buildPrePassOnce(bytes);
    result = api.processGeometryBatchPartitioned(bytes, pre.jobs, pre.unitScale, ...pre.rtcOffset,
      pre.needsShift, pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors);
    const flat = new Map();
    const collection = result.takeMeshes();
    try {
      for (let i = 0; i < collection.length; i++) {
        const mesh = collection.get(i);
        try {
          flat.set(mesh.expressId, mesh.ifcType);
        } finally {
          mesh.free();
        }
      }
    } finally {
      collection.free();
    }
    const shard = result.takeShard();
    const instanced = shard.byteLength > 0
      ? decodeInstancedShard(shard).instances.map((instance) => instance.entityId)
      : [];
    return { flat, instanced };
  } finally {
    result?.free();
    api.clearPrePassCache();
    api.free();
  }
}

export async function runClassToggleShardContract(IfcAPI, test) {
  console.log('\n📋 #5409 class-toggled classes stay off the instanced shard');
  // Type stripping loads the viewer table from source; its only import is
  // type-only, so nothing else needs resolving.
  const { buildHiddenIfcTypes } = await import('../../apps/viewer/src/store/typeVisibilityFilter.ts');
  const allOff = { spaces: false, spatialZones: false, openings: false, virtualElements: false,
    site: false, ifcAnnotations: false };
  const toggled = [...buildHiddenIfcTypes(allOff)].sort();

  test('every class the viewer toggles as a class renders flat, carrying its ifcType', () => {
    assert.ok(toggled.length > 0, 'the viewer table yielded no classes');
    const { bytes, owners } = fixture([...toggled, 'IfcWall']);
    const { flat, instanced } = partition(IfcAPI, bytes);

    const walls = [...owners].filter(([, cls]) => cls === 'IfcWall').map(([eid]) => eid);
    assert.deepEqual(
      instanced.filter((eid) => owners.get(eid) === 'IfcWall').sort((a, b) => a - b),
      walls,
      'control: the repeated opaque IfcWall group must instance, or this fixture proves nothing',
    );
    const leaked = instanced.filter((eid) => owners.get(eid) !== 'IfcWall').map((eid) => `#${eid} ${owners.get(eid)}`);
    assert.deepEqual(leaked, [], 'class-toggled occurrences reached the shard, where no class toggle can hide them');
    for (const cls of toggled) {
      const members = [...owners].filter(([, c]) => c === cls).map(([eid]) => eid);
      const rendered = members.filter((eid) => flat.get(eid) === cls);
      assert.deepEqual(rendered, members, `${cls}: every occurrence must render flat as ${cls}`);
    }
  });
}
