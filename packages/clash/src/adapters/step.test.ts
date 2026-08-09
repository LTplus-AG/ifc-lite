/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import type { MeshData } from '@ifc-lite/geometry';
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
#4=IFCDOORSTYLE('${DOORSTYLE_GUID}',$,'Door Style',$,$,$,$,.NOTDEFINED.,.NOTDEFINED.,.F.,.F.);
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
