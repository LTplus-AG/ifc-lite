/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import type { MeshData } from '@ifc-lite/geometry';
import { createClashEngine } from '../engine.js';
import { elementsFromStep } from './step.js';

const WALL_GUID = '3vB2YO$MX4xv5uCqZZG05x';

const MINIMAL_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('minimal.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCWALL('${WALL_GUID}',$,'Test Wall',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
`;

const SPACE_GUID = '1aB2cD3eF4gH5iJ6kL7mN8';

const STOREY_GUID = '2sT0rEyAX4xv5uCqZZG05x';
const SLAB_GUID = '3sL4bZZAX4xv5uCqZZG05x';

// A storey that carries tessellated geometry (common in IFC4.3 infrastructure
// exports) plus the two elements it contains. The storey is a spatial
// *container*, so it is not a clash body; the two contained elements still are.
// (follow-up to #1464)
const STOREY_WITH_GEOMETRY_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('storey.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCBUILDINGSTOREY('${STOREY_GUID}',$,'Level 0',$,$,$,$,$,.ELEMENT.,0.);
#2=IFCSLAB('${SLAB_GUID}',$,'Approach slab',$,$,$,$,$,$);
#3=IFCWALL('${WALL_GUID}',$,'Test Wall',$,$,$,$,$,$);
#4=IFCRELCONTAINEDINSPATIALSTRUCTURE('0rEl00$MX4xv5uCqZZG05x',$,$,$,(#2,#3),#1);
ENDSEC;
END-ISO-10303-21;
`;

// A wall (clashable) plus a space (non-physical -> must be dropped). (#1464)
const WALL_AND_SPACE_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('mixed.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCWALL('${WALL_GUID}',$,'Test Wall',$,$,$,$,$,$);
#2=IFCSPACE('${SPACE_GUID}',$,'Test Space',$,$,$,$,$,.ELEMENT.,$,$);
ENDSEC;
END-ISO-10303-21;
`;

const WALLTYPE_GUID = '2zZ9yY8xX7wW6vV5uU4tT3';
const SPACETYPE_GUID = '0qQ1rR2sS3tT4uU5vV6wW7';
const DOORSTYLE_GUID = '9pP8oO7nN6mM5lL4kK3jJ2';

// A wall (an occurrence) plus the type objects that define it. Type objects
// carry a `RepresentationMaps` template that the mesher happily turns into
// geometry sitting on top of the occurrences that use it — but a type is not a
// physical object, so it must never become a clash candidate. Two of them are
// spelled `...Style` rather than `...Type` (IfcDoorStyle / IfcWindowStyle — the
// IFC2X3 spelling, still present but deprecated in IFC4).
const WALL_AND_TYPES_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('types.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCWALL('${WALL_GUID}',$,'Test Wall',$,$,$,$,$,$);
#2=IFCWALLTYPE('${WALLTYPE_GUID}',$,'Wall Type',$,$,$,$,$,$,.STANDARD.);
#3=IFCSPACETYPE('${SPACETYPE_GUID}',$,'Space Type',$,$,$,$,$,$,.SPACE.,$);
#4=IFCDOORSTYLE('${DOORSTYLE_GUID}',$,'Door Style',$,$,$,$,$,.NOTDEFINED.,.NOTDEFINED.,.F.,.F.);
ENDSEC;
END-ISO-10303-21;
`;

function unitBoxMesh(expressId: number): MeshData {
  const positions = new Float32Array([
    0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
    0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1,
  ]);
  return {
    expressId,
    ifcType: 'IfcWall',
    positions,
    normals: new Float32Array(positions.length),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    color: [0.5, 0.5, 0.5, 1],
  };
}

// IFC4.3 infrastructure containers, none of which the parser's IFC4 codegen pin
// knows: they only classify as spatial through the bundled schema union.
const INFRA_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('infra.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4X3'));
ENDSEC;
DATA;
#1=IFCROAD('1rO4d00AX4xv5uCqZZG05x',$,'Road',$,$,$,$,$,.ELEMENT.);
#2=IFCFACILITYPART('2fP4rt0AX4xv5uCqZZG05x',$,'Carriageway',$,$,$,$,$,.ELEMENT.,$,$);
#3=IFCSITE('3sItE00AX4xv5uCqZZG05x',$,'Site',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);
#4=IFCWALL('${WALL_GUID}',$,'Test Wall',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
`;

/**
 * A closed unit cube (12 triangles) at `[ox, 0, 0]`, so two of them can be made
 * to genuinely overlap in volume. `unitBoxMesh` above is a single coplanar quad
 * and never produces a penetration.
 */
function solidBoxMesh(expressId: number, ox: number): MeshData {
  const c = [
    [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
    [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
  ];
  const positions = new Float32Array(c.flatMap(([x, y, z]) => [x + ox, y, z]));
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2, // bottom
    4, 5, 6, 4, 6, 7, // top
    0, 1, 5, 0, 5, 4, // -y
    1, 2, 6, 1, 6, 5, // +x
    2, 3, 7, 2, 7, 6, // +y
    3, 0, 4, 3, 4, 7, // -x
  ]);
  return {
    expressId,
    ifcType: 'IfcBuildingElementProxy',
    positions,
    normals: new Float32Array(positions.length),
    indices,
    color: [0.5, 0.5, 0.5, 1],
  };
}

describe('elementsFromStep', () => {
  it('maps a parsed wall + mesh into a ClashElement', async () => {
    const store = await new IfcParser().parseColumnar(
      new TextEncoder().encode(MINIMAL_IFC).buffer as ArrayBuffer,
    );

    const wallIds = store.entityIndex.byType.get('IFCWALL') ?? [];
    expect(wallIds.length).toBe(1);
    const expressId = wallIds[0];

    const { elements, exclusions } = elementsFromStep({
      store,
      meshes: [unitBoxMesh(expressId)],
      modelId: 'model-1',
    });

    expect(elements).toHaveLength(1);
    const el = elements[0];
    expect(el.key).toBe(WALL_GUID);
    expect(el.tag.toLowerCase()).toContain('wall');
    expect(el.ref).toBe(expressId); // no federation → expressId
    expect(el.model).toBe('model-1');
    expect(el.bounds.min).toEqual([0, 0, 0]);
    expect(el.bounds.max).toEqual([1, 1, 1]);
    expect(exclusions instanceof Set).toBe(true);
  });

  it('drops non-physical types (IfcSpace) from clash candidates (#1464)', async () => {
    const store = await new IfcParser().parseColumnar(
      new TextEncoder().encode(WALL_AND_SPACE_IFC).buffer as ArrayBuffer,
    );
    const wallId = (store.entityIndex.byType.get('IFCWALL') ?? [])[0];
    const spaceId = (store.entityIndex.byType.get('IFCSPACE') ?? [])[0];
    expect(wallId).toBeGreaterThan(0);
    expect(spaceId).toBeGreaterThan(0);

    // Both carry geometry, but only the wall is a real clash candidate.
    const { elements } = elementsFromStep({
      store,
      meshes: [unitBoxMesh(wallId), unitBoxMesh(spaceId)],
      modelId: 'm',
    });

    expect(elements).toHaveLength(1);
    expect(elements[0].tag.toLowerCase()).toContain('wall');
  });

  it('drops spatial containers carrying geometry (IfcBuildingStorey) (follow-up to #1464)', async () => {
    const store = await new IfcParser().parseColumnar(
      new TextEncoder().encode(STOREY_WITH_GEOMETRY_IFC).buffer as ArrayBuffer,
    );
    const storeyId = (store.entityIndex.byType.get('IFCBUILDINGSTOREY') ?? [])[0];
    const slabId = (store.entityIndex.byType.get('IFCSLAB') ?? [])[0];
    const wallId = (store.entityIndex.byType.get('IFCWALL') ?? [])[0];
    expect(storeyId).toBeGreaterThan(0);

    // All three carry geometry; only the two contained elements are bodies.
    const { elements } = elementsFromStep({
      store,
      meshes: [solidBoxMesh(storeyId, 0), solidBoxMesh(slabId, 0), solidBoxMesh(wallId, 0.5)],
      modelId: 'm',
    });

    expect(elements.map((e) => e.tag).sort()).toEqual(['IfcSlab', 'IfcWall']);
    // The storey survives as *metadata* on the elements it contains.
    expect(elements.every((e) => e.storey === 'Level 0')).toBe(true);
  });

  it('still clashes two elements contained in the same storey (follow-up to #1464, control)', async () => {
    const store = await new IfcParser().parseColumnar(
      new TextEncoder().encode(STOREY_WITH_GEOMETRY_IFC).buffer as ArrayBuffer,
    );
    const storeyId = (store.entityIndex.byType.get('IFCBUILDINGSTOREY') ?? [])[0];
    const slabId = (store.entityIndex.byType.get('IFCSLAB') ?? [])[0];
    const wallId = (store.entityIndex.byType.get('IFCWALL') ?? [])[0];

    const { elements, exclusions } = elementsFromStep({
      store,
      meshes: [solidBoxMesh(storeyId, 0), solidBoxMesh(slabId, 0), solidBoxMesh(wallId, 0.5)],
      modelId: 'm',
    });

    const engine = createClashEngine({ backend: 'ts' });
    const result = await engine.run(
      elements,
      [{ id: 'r', name: 'all', a: '*', mode: 'hard' }],
      { exclusions },
    );

    // Exactly one pair remains: slab x wall. Dropping the storey body must not
    // cost the contained elements their own clash.
    expect(result.clashes).toHaveLength(1);
    const tags = [result.clashes[0].a.tag, result.clashes[0].b.tag].sort();
    expect(tags).toEqual(['IfcSlab', 'IfcWall']);
  });

  it('drops IFC4.3 facility containers the IFC4 pin does not know (follow-up to #1464)', async () => {
    const store = await new IfcParser().parseColumnar(
      new TextEncoder().encode(INFRA_IFC).buffer as ArrayBuffer,
    );
    const ids = ['IFCROAD', 'IFCFACILITYPART', 'IFCSITE', 'IFCWALL'].map(
      (t) => (store.entityIndex.byType.get(t) ?? [])[0],
    );
    expect(ids.every((id) => id > 0)).toBe(true);

    const { elements } = elementsFromStep({
      store,
      meshes: ids.map((id) => solidBoxMesh(id, 0)),
      modelId: 'm',
    });

    expect(elements.map((e) => e.tag)).toEqual(['IfcWall']);
  });

  it('drops IFC type objects, whose template geometry sits on the occurrences using it', async () => {
    const store = await new IfcParser().parseColumnar(
      new TextEncoder().encode(WALL_AND_TYPES_IFC).buffer as ArrayBuffer,
    );
    const id = (type: string): number => {
      const ids = store.entityIndex.byType.get(type) ?? [];
      expect(ids.length).toBe(1);
      return ids[0];
    };

    const { elements } = elementsFromStep({
      store,
      meshes: [
        unitBoxMesh(id('IFCWALL')),
        unitBoxMesh(id('IFCWALLTYPE')),
        unitBoxMesh(id('IFCSPACETYPE')),
        unitBoxMesh(id('IFCDOORSTYLE')),
      ],
      modelId: 'm',
    });

    expect(elements.map((e) => e.tag)).toEqual(['IfcWall']);
  });

  it('skips meshes with empty geometry', async () => {
    const store = await new IfcParser().parseColumnar(
      new TextEncoder().encode(MINIMAL_IFC).buffer as ArrayBuffer,
    );
    const expressId = (store.entityIndex.byType.get('IFCWALL') ?? [])[0];
    const empty: MeshData = {
      expressId,
      positions: new Float32Array(0),
      normals: new Float32Array(0),
      indices: new Uint32Array(0),
      color: [1, 1, 1, 1],
    };
    const { elements } = elementsFromStep({ store, meshes: [empty], modelId: 'm' });
    expect(elements).toHaveLength(0);
  });
});
