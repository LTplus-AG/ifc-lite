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
