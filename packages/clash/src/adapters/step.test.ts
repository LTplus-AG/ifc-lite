/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from 'vitest';
import { createSyntheticDataStore, IfcParser } from '@ifc-lite/parser';
import type { MeshData } from '@ifc-lite/geometry';
import { createClashEngine } from '../engine.js';
import { clashReviewKey } from '../review.js';
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
function solidBoxMesh(expressId: number, ox: number, occurrenceKey?: string): MeshData {
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
    ...(occurrenceKey ? { occurrenceKey } : {}),
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

// A federated model past the first: the viewer's loader (`useIfcLoader`) shifts
// every `mesh.expressId` into the global id space by that model's `idOffset`
// BEFORE anything downstream sees the meshes. The `IfcDataStore` is untouched
// and stays in the LOCAL id space, so an adapter handed those meshes has to
// subtract the offset back out before it can look anything up.
const FED_OFFSET = 1_000_000;

const FED_WALL_GUID = '0fEdW4LLX4xv5uCqZZG05x';
const FED_DOOR_GUID = '0fEdD00RX4xv5uCqZZG05x';
const FED_OPENING_GUID = '0fEd0pENX4xv5uCqZZG05x';
const FED_STOREY_GUID = '0fEdSt0YX4xv5uCqZZG05x';

// Wall hosting an opening that a door fills, both contained in a storey. The
// wall/door pair is exactly the void/host exclusion the engine must honour.
const FEDERATED_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('federated.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCBUILDINGSTOREY('${FED_STOREY_GUID}',$,'Level 3',$,$,$,$,$,.ELEMENT.,9.);
#2=IFCWALL('${FED_WALL_GUID}',$,'Federated Wall',$,$,$,$,$,$);
#3=IFCOPENINGELEMENT('${FED_OPENING_GUID}',$,'Door Opening',$,$,$,$,$,$);
#4=IFCDOOR('${FED_DOOR_GUID}',$,'Federated Door',$,$,$,$,$,$,$,$,$,$);
#5=IFCRELVOIDSELEMENT('1v01d00AX4xv5uCqZZG05x',$,$,$,#2,#3);
#6=IFCRELFILLSELEMENT('1f1LLs0AX4xv5uCqZZG05x',$,$,$,#3,#4);
#7=IFCRELCONTAINEDINSPATIALSTRUCTURE('1c0nt40AX4xv5uCqZZG05x',$,$,$,(#2,#4),#1);
ENDSEC;
END-ISO-10303-21;
`;

/** The viewer's federation bridge: local expressId -> global id. */
const fedFederation = { toGlobalId: (_modelId: string, expressId: number) => expressId + FED_OFFSET };

describe('elementsFromStep - federated model at a non-zero id offset', () => {
  it('resolves key / tag / name / storey / ref from meshes the loader already shifted', async () => {
    const store = await new IfcParser().parseColumnar(
      new TextEncoder().encode(FEDERATED_IFC).buffer as ArrayBuffer,
    );
    const wallId = (store.entityIndex.byType.get('IFCWALL') ?? [])[0];
    expect(wallId).toBeGreaterThan(0);

    const { elements } = elementsFromStep({
      store,
      // As the loader leaves them: already in the global id space.
      meshes: [solidBoxMesh(wallId + FED_OFFSET, 0)],
      modelId: 'model-2',
      federation: fedFederation,
      meshIdOffset: FED_OFFSET,
    });

    expect(elements).toHaveLength(1);
    const el = elements[0];
    // The DURABLE key must be the real IfcGUID, never the synthetic fallback.
    expect(el.key).toBe(FED_WALL_GUID);
    expect(el.key.startsWith('expressid:')).toBe(false);
    expect(el.tag).toBe('IfcWall');
    expect(el.name).toBe('Federated Wall');
    expect(el.storey).toBe('Level 3');
    // The offset is applied exactly ONCE, so the ref IS the mesh's own
    // (already global) id — the one the renderer and the selection channel
    // address this element by, and the one `fromGlobalId` in `useClash.refOf`
    // round-trips back to (model-2, wallId).
    expect(el.ref).toBe(wallId + FED_OFFSET);
    expect(el.ref).not.toBe(wallId + 2 * FED_OFFSET); // the double-offset defect
  });

  it('honours the void/host exclusion for a federated model (silent-failure half)', async () => {
    const store = await new IfcParser().parseColumnar(
      new TextEncoder().encode(FEDERATED_IFC).buffer as ArrayBuffer,
    );
    const wallId = (store.entityIndex.byType.get('IFCWALL') ?? [])[0];
    const doorId = (store.entityIndex.byType.get('IFCDOOR') ?? [])[0];
    expect(wallId).toBeGreaterThan(0);
    expect(doorId).toBeGreaterThan(0);

    // Overlapping bodies: without the exclusion this is one hard clash.
    const { elements, exclusions } = elementsFromStep({
      store,
      meshes: [solidBoxMesh(wallId + FED_OFFSET, 0), solidBoxMesh(doorId + FED_OFFSET, 0.5)],
      modelId: 'model-2',
      federation: fedFederation,
      meshIdOffset: FED_OFFSET,
    });
    expect(elements).toHaveLength(2);

    const engine = createClashEngine({ backend: 'ts' });
    const result = await engine.run(
      elements,
      [{ id: 'r', name: 'all', a: '*', mode: 'hard' }],
      { exclusions },
    );

    // A door in the opening it fills is not a clash — for the second model too.
    expect(result.clashes).toHaveLength(0);
  });

  it('control: the same fixture at offset 0 already worked', async () => {
    const store = await new IfcParser().parseColumnar(
      new TextEncoder().encode(FEDERATED_IFC).buffer as ArrayBuffer,
    );
    const wallId = (store.entityIndex.byType.get('IFCWALL') ?? [])[0];
    const doorId = (store.entityIndex.byType.get('IFCDOOR') ?? [])[0];

    const { elements, exclusions } = elementsFromStep({
      store,
      meshes: [solidBoxMesh(wallId, 0), solidBoxMesh(doorId, 0.5)],
      modelId: 'model-1',
      federation: { toGlobalId: (_m, id) => id },
      meshIdOffset: 0,
    });

    expect(elements.find((e) => e.tag === 'IfcWall')?.key).toBe(FED_WALL_GUID);
    const engine = createClashEngine({ backend: 'ts' });
    const result = await engine.run(elements, [{ id: 'r', name: 'all', a: '*', mode: 'hard' }], {
      exclusions,
    });
    expect(result.clashes).toHaveLength(0);
  });
});

/**
 * The TOTAL-MISS guard.
 *
 * A forgotten `meshIdOffset` produces nothing an assertion on the id itself
 * could catch: `mesh.expressId - 0` is positive, plausible, and simply
 * addresses the wrong row. What IS distinctive is the SHAPE of the damage —
 * every single GlobalId lookup misses, never some. Real IFC does have the
 * occasional fallback-only root with no GlobalId, but "not one element in this
 * model has one" is a wiring bug, not a file.
 *
 * See the `meshIdOffset` JSDoc on `StepAdapterOptions` for why a dev-only
 * `expressId < 0` assert was rejected instead: it fires only on a too-LARGE
 * subtrahend, the mirror image of the failure that actually shipped.
 */
describe('elementsFromStep - total GlobalId miss warning', () => {
  async function fedStore() {
    return new IfcParser().parseColumnar(
      new TextEncoder().encode(FEDERATED_IFC).buffer as ArrayBuffer,
    );
  }

  it('warns ONCE when every element misses, naming the model and the offset it used', async () => {
    const store = await fedStore();
    const wallId = (store.entityIndex.byType.get('IFCWALL') ?? [])[0];
    const doorId = (store.entityIndex.byType.get('IFCDOOR') ?? [])[0];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // The defect verbatim: meshes already shifted, `meshIdOffset` forgotten.
      const { elements } = elementsFromStep({
        store,
        meshes: [solidBoxMesh(wallId + FED_OFFSET, 0), solidBoxMesh(doorId + FED_OFFSET, 0.5)],
        modelId: 'model-2',
        federation: fedFederation,
      });
      expect(elements).toHaveLength(2);
      expect(warn).toHaveBeenCalledTimes(1);
      const msg = warn.mock.calls[0].join(' ');
      expect(msg).toContain('[clash/step]');
      expect(msg).toContain('model-2');
      expect(msg).toContain('meshIdOffset');
    } finally {
      warn.mockRestore();
    }
  });

  it('stays silent when the offset IS passed', async () => {
    const store = await fedStore();
    const wallId = (store.entityIndex.byType.get('IFCWALL') ?? [])[0];
    const doorId = (store.entityIndex.byType.get('IFCDOOR') ?? [])[0];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      elementsFromStep({
        store,
        meshes: [solidBoxMesh(wallId + FED_OFFSET, 0), solidBoxMesh(doorId + FED_OFFSET, 0.5)],
        modelId: 'model-2',
        federation: fedFederation,
        meshIdOffset: FED_OFFSET,
      });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('stays silent on a PARTIAL miss: that is a file with fallback-only roots, not a wiring bug', async () => {
    const store = await fedStore();
    const wallId = (store.entityIndex.byType.get('IFCWALL') ?? [])[0];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { elements } = elementsFromStep({
        store,
        // One real wall, one mesh for an id the store simply does not have.
        meshes: [solidBoxMesh(wallId, 0), solidBoxMesh(987_654, 0.5)],
        modelId: 'model-1',
        meshIdOffset: 0,
      });
      expect(elements).toHaveLength(2);
      expect(elements.filter((e) => e.key.startsWith('expressid:'))).toHaveLength(1);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('stays silent when there are no elements at all', async () => {
    const store = await fedStore();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { elements } = elementsFromStep({ store, meshes: [], modelId: 'model-1' });
      expect(elements).toHaveLength(0);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('stays silent for an entity-less (GLB) store, where every miss is EXPECTED', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Exactly what the viewer's GLB ingest builds (`createMinimalGlbDataStore`):
      // renderable meshes, no IFC entity rows at all. Every element falling back
      // is the normal state of that model, not a host wiring bug.
      const { elements } = elementsFromStep({
        store: createSyntheticDataStore({ schemaVersion: 'IFC4', fileSize: 1, entityCount: 2 }),
        meshes: [solidBoxMesh(1, 0), solidBoxMesh(2, 0.5)],
        modelId: 'glb-model',
      });
      expect(elements).toHaveLength(2);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('stays silent when the store HAS rows but none of them carries a GlobalId', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      elementsFromStep({
        store: createSyntheticDataStore({
          schemaVersion: 'IFC4',
          fileSize: 1,
          // Rows the ids DO hit — they simply have no GlobalId. A malformed
          // export, not an offset the host forgot.
          entities: [
            { expressId: 1, type: 'IfcWall' },
            { expressId: 2, type: 'IfcWall' },
          ],
        }),
        meshes: [solidBoxMesh(1, 0), solidBoxMesh(2, 0.5)],
        modelId: 'guidless-model',
      });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

/**
 * The SYNTHETIC FALLBACK KEY has to be unique per model.
 *
 * `key` is the durable element identity, and both `clashReviewKey`
 * (`../review.ts`) and the viewer's `elementPairExclusion`
 * (`apps/viewer/src/lib/clash/exclusions.ts`) key on it ALONE — dropping
 * `model` on purpose, because in the viewer that is a per-load
 * `crypto.randomUUID()` and folding it in would make every saved rule go inert
 * on the next reload. That makes an UNQUALIFIED fallback dangerous the moment
 * two models are federated: a bare `expressid:2` means "element 2" in both of
 * them, so a review status or a user exclusion set on one model's element also
 * covers a different model's element.
 *
 * The natural population is a GLB-sourced federation: the viewer's GLB ingest
 * builds an entity-less store, so every element legitimately falls back, and
 * two such models fall back onto the same ids from 1 upwards.
 */
describe('elementsFromStep - the fallback key is model-scoped', () => {
  function glbStore() {
    return createSyntheticDataStore({ schemaVersion: 'IFC4', fileSize: 1, entityCount: 2 });
  }

  it('mints DIFFERENT keys for the same local express id in two models', () => {
    const a = elementsFromStep({ store: glbStore(), meshes: [solidBoxMesh(2, 0)], modelId: 'model-a' });
    const b = elementsFromStep({ store: glbStore(), meshes: [solidBoxMesh(2, 0)], modelId: 'model-b' });

    expect(a.elements[0].key.startsWith('expressid:')).toBe(true);
    expect(b.elements[0].key.startsWith('expressid:')).toBe(true);
    expect(a.elements[0].key).not.toBe(b.elements[0].key);
  });

  it('keeps the two models apart in `clashReviewKey` — the durable review identity', () => {
    const build = (modelId: string) =>
      elementsFromStep({
        store: glbStore(),
        meshes: [solidBoxMesh(1, 0), solidBoxMesh(2, 0.5)],
        modelId,
      }).elements;
    const a = build('model-a');
    const b = build('model-b');

    const keyA = clashReviewKey({ rule: 'r', a: a[0], b: a[1] });
    const keyB = clashReviewKey({ rule: 'r', a: b[0], b: b[1] });

    // Two clashes in two models must be two review keys. One key here means a
    // status set on model A's pair silently marks model B's pair reviewed too.
    expect(new Set([keyA, keyB]).size).toBe(2);
  });

  it('never lets a model id put a SPACE inside the key — `clashReviewKey` separates on one', () => {
    // A CLI run keys the model on `basename(filePath)`, and file names have spaces.
    const { elements } = elementsFromStep({
      store: glbStore(),
      meshes: [solidBoxMesh(2, 0)],
      modelId: 'Bridge Model rev B.ifc',
    });
    expect(elements[0].key).not.toMatch(/\s/);
    // ...and the encoding stays injective: a different model is a different key.
    const other = elementsFromStep({
      store: glbStore(),
      meshes: [solidBoxMesh(2, 0)],
      modelId: 'Bridge Model rev C.ifc',
    });
    expect(other.elements[0].key).not.toBe(elements[0].key);
  });

  it('leaves a real IfcGUID untouched: only the FALLBACK changes shape', async () => {
    const store = await new IfcParser().parseColumnar(
      new TextEncoder().encode(FEDERATED_IFC).buffer as ArrayBuffer,
    );
    const wallId = (store.entityIndex.byType.get('IFCWALL') ?? [])[0];
    const { elements } = elementsFromStep({
      store,
      meshes: [solidBoxMesh(wallId, 0)],
      modelId: 'model-2',
    });
    expect(elements[0].key).toBe(FED_WALL_GUID);
  });
});

describe('elementsFromStep - coalesces multiple meshes per entity (parity with elementsFromIfcx)', () => {
  it('merges two meshes on the same expressId into ONE ClashElement with unioned bounds', async () => {
    const store = await new IfcParser().parseColumnar(
      new TextEncoder().encode(MINIMAL_IFC).buffer as ArrayBuffer,
    );
    const wallIds = store.entityIndex.byType.get('IFCWALL') ?? [];
    const expressId = wallIds[0];

    // Two disjoint boxes on the SAME entity (e.g. Body + Axis representations).
    const { elements } = elementsFromStep({
      store,
      meshes: [solidBoxMesh(expressId, 0), solidBoxMesh(expressId, 10)],
      modelId: 'model-1',
    });

    // Exactly one ClashElement per entity, not one per mesh.
    expect(elements).toHaveLength(1);
    const el = elements[0];
    expect(el.key).toBe(WALL_GUID);
    // Bounds must be the UNION of both meshes, not just the last mesh's box.
    expect(el.bounds.min).toEqual([0, 0, 0]);
    expect(el.bounds.max).toEqual([11, 1, 1]);
    // Both sub-meshes' geometry is present (8 verts * 2, 36 indices * 2).
    expect(el.positions.length).toBe(8 * 3 * 2);
    expect(el.indices.length).toBe(36 * 2);
  });

  it('exclusions survive when the DOOR (the filler) has multiple meshes', async () => {
    const store = await new IfcParser().parseColumnar(
      new TextEncoder().encode(FEDERATED_IFC).buffer as ArrayBuffer,
    );
    const wallId = (store.entityIndex.byType.get('IFCWALL') ?? [])[0];
    const doorId = (store.entityIndex.byType.get('IFCDOOR') ?? [])[0];

    // Door has TWO DISJOINT meshes (e.g. a Body that overlaps the wall plus a
    // separate Axis representation elsewhere — the same shape as `ifcx.ts`'s
    // WallC fixture). If `byExpressId` were last-write-wins and only the
    // second (non-overlapping) mesh survived, the void/host exclusion below
    // would never even matter because the wall/door pair would look
    // non-overlapping instead of merely excluded — which is exactly the
    // silent failure mode this test pins.
    const { elements, exclusions } = elementsFromStep({
      store,
      meshes: [
        solidBoxMesh(wallId, 0),
        solidBoxMesh(doorId, 0.5),
        solidBoxMesh(doorId, 5),
      ],
      modelId: 'model-1',
    });

    // One element per entity: wall + door (opening dropped by the #1464 filter).
    expect(elements).toHaveLength(2);

    const engine = createClashEngine({ backend: 'ts' });

    // Positive control: without the exclusion, the wall and door genuinely
    // overlap — proves the "0 clashes" below is the exclusion doing its job,
    // not just non-overlapping geometry.
    const open = await engine.run(
      elements,
      [{ id: 'r', name: 'all', a: '*', mode: 'hard' }],
      { excludeVoidsAndHosts: false },
    );
    expect(open.clashes.length).toBeGreaterThan(0);

    const result = await engine.run(
      elements,
      [{ id: 'r', name: 'all', a: '*', mode: 'hard' }],
      { exclusions },
    );

    // The void/host exclusion between the wall and its door must still apply
    // to the door's MERGED geometry, not just whichever mesh happened to
    // overwrite `byExpressId` last.
    expect(result.clashes).toHaveLength(0);
  });
});

/**
 * GPU-instanced occurrences (#2865). The renderer's `Scene.getInstancedMeshDataPieces`
 * materializes one `MeshData` PER PHYSICAL OCCURRENCE for an entity whose whole
 * mesh set was fully instanced — all of them stamped with the SAME `expressId`,
 * distinguished only by `occurrenceKey` (see `MeshData.occurrenceKey`, issue
 * #1405). `elementsFromStep` is the only place that turns those pieces into
 * `ClashElement`s, so it is the one place that can silently collapse them.
 *
 * Before this fix, `byExpressId` was a `Map<number, ClashElement>`: the SECOND
 * occurrence pushed under one expressId overwrote the first. `key` was built
 * from the GlobalId alone, with no `occurrenceKey` folded in, so two physically
 * distinct occurrences minted the IDENTICAL durable key — one review status /
 * exclusion for two different objects. And `buildStepExclusions` walked
 * relationships off `byExpressId`, so a void/host exclusion reached only
 * whichever occurrence happened to be built last, leaving every earlier
 * occurrence to clash against its own host as a false positive.
 */
describe('elementsFromStep - GPU-instanced occurrences of one expressId (#2865)', () => {
  it('mints a DIFFERENT key per occurrence, so review status cannot collapse across them', async () => {
    const store = await new IfcParser().parseColumnar(
      new TextEncoder().encode(FEDERATED_IFC).buffer as ArrayBuffer,
    );
    const doorId = (store.entityIndex.byType.get('IFCDOOR') ?? [])[0];

    const occA: MeshData = { ...solidBoxMesh(doorId, 5), occurrenceKey: `${doorId}:inst:0:0` };
    const occB: MeshData = { ...solidBoxMesh(doorId, 8), occurrenceKey: `${doorId}:inst:0:64` };

    const { elements } = elementsFromStep({ store, meshes: [occA, occB], modelId: 'm' });

    expect(elements).toHaveLength(2);
    expect(elements[0].key).not.toBe(elements[1].key);
    expect(elements[0].key.startsWith(FED_DOOR_GUID)).toBe(true);
    expect(elements[1].key.startsWith(FED_DOOR_GUID)).toBe(true);

    const reviewKeys = new Set([
      clashReviewKey({ rule: 'r', a: elements[0], b: elements[0] }),
      clashReviewKey({ rule: 'r', a: elements[1], b: elements[1] }),
    ]);
    expect(reviewKeys.size).toBe(2);
  });

  it('fans a void/host exclusion out to EVERY occurrence of the filler, not just the last one built', async () => {
    const store = await new IfcParser().parseColumnar(
      new TextEncoder().encode(FEDERATED_IFC).buffer as ArrayBuffer,
    );
    const wallId = (store.entityIndex.byType.get('IFCWALL') ?? [])[0];
    const doorId = (store.entityIndex.byType.get('IFCDOOR') ?? [])[0];

    // Both door occurrences deliberately overlap the wall (`[0, 1]` on x) in
    // space — without the relationship exclusion reaching BOTH, at least one
    // is a hard clash. Positioned clear of EACH OTHER (`[-0.5, 0.5]` and
    // `[0.6, 1.6]` don't overlap) so the only intersections in play are each
    // occurrence against the wall, not the two occurrences against each other.
    const occA: MeshData = { ...solidBoxMesh(doorId, -0.5), occurrenceKey: `${doorId}:inst:0:0` };
    const occB: MeshData = { ...solidBoxMesh(doorId, 0.6), occurrenceKey: `${doorId}:inst:0:64` };

    const { elements, exclusions } = elementsFromStep({
      store,
      meshes: [solidBoxMesh(wallId, 0), occA, occB],
      modelId: 'm',
    });
    expect(elements).toHaveLength(3);

    const engine = createClashEngine({ backend: 'ts' });
    const result = await engine.run(
      elements,
      [{ id: 'r', name: 'all', a: '*', mode: 'hard' }],
      { exclusions },
    );

    expect(result.clashes).toHaveLength(0);
  });
});

describe('elementsFromStep - keeps GPU-instanced occurrences distinct (PR #2819 review)', () => {
  it('two meshes sharing one expressId but different occurrenceKey become TWO ClashElements, not one merged element', async () => {
    const store = await new IfcParser().parseColumnar(
      new TextEncoder().encode(MINIMAL_IFC).buffer as ArrayBuffer,
    );
    const wallIds = store.entityIndex.byType.get('IFCWALL') ?? [];
    const expressId = wallIds[0];

    // Two DISTINCT physical occurrences of the same GPU-instanced entity, far
    // apart in world space — exactly what `withInstancedMeshes` materializes
    // from the renderer scene for an entity repeated 8+ times (occurrenceKey
    // present, unlike the Body/Axis-representation case above).
    const { elements } = elementsFromStep({
      store,
      meshes: [
        solidBoxMesh(expressId, 0, `${expressId}:inst:0:0`),
        solidBoxMesh(expressId, 100, `${expressId}:inst:0:1`),
      ],
      modelId: 'model-1',
    });

    // Coalescing by bare expressId would merge these into ONE element with a
    // bounding box spanning x=[0,101] — false clashes against anything in
    // between, and the two real, physically distinct occurrences erased from
    // the result set.
    expect(elements).toHaveLength(2);
    const byOx = [...elements].sort((a, b) => a.bounds.min[0] - b.bounds.min[0]);
    expect(byOx[0].bounds.min).toEqual([0, 0, 0]);
    expect(byOx[0].bounds.max).toEqual([1, 1, 1]);
    expect(byOx[1].bounds.min).toEqual([100, 0, 0]);
    expect(byOx[1].bounds.max).toEqual([101, 1, 1]);

    // Each occurrence keeps a DISTINCT key (occurrenceKey folded in) so a
    // review/exclusion decision on one cannot silently cover the other.
    expect(byOx[0].key).not.toBe(byOx[1].key);
    expect(new Set(elements.map((e) => e.key)).size).toBe(2);

    // `ref` (the renderer/selection id) is deliberately SHARED across
    // occurrences of one entity — that is the existing, documented contract,
    // not part of this bug.
    expect(byOx[0].ref).toBe(byOx[1].ref);
  });

  it('a void/host exclusion on an instanced expressId fans out to every occurrence', async () => {
    const store = await new IfcParser().parseColumnar(
      new TextEncoder().encode(FEDERATED_IFC).buffer as ArrayBuffer,
    );
    const wallId = (store.entityIndex.byType.get('IFCWALL') ?? [])[0];
    const doorId = (store.entityIndex.byType.get('IFCDOOR') ?? [])[0];

    // The door is GPU-instanced: two occurrences share `doorId`, each
    // overlapping the SAME wall at a different point along it. The wall
    // itself gets a SECOND mesh representation at x=20 (no occurrenceKey, so
    // it merges into the same wall element per `mergeMeshes`) so its bounds
    // span both door occurrences — otherwise the second door (x=[20.5,21.5])
    // would never physically overlap a wall confined to x=[0,1], and the
    // exclusion fan-out this test exists to verify would go unexercised for
    // that occurrence: the test could pass with no clashes simply because
    // there was never a candidate pair there, not because the exclusion
    // fanned out correctly.
    const { elements, exclusions } = elementsFromStep({
      store,
      meshes: [
        solidBoxMesh(wallId, 0),
        solidBoxMesh(wallId, 20),
        solidBoxMesh(doorId, 0.5, `${doorId}:inst:0:0`),
        solidBoxMesh(doorId, 20.5, `${doorId}:inst:0:1`),
      ],
      modelId: 'model-1',
    });

    // Wall (its two mesh representations merged into one element) + two
    // distinct door occurrences (opening dropped by the #1464 filter).
    expect(elements).toHaveLength(3);

    const engine = createClashEngine({ backend: 'ts' });
    const result = await engine.run(
      elements,
      [{ id: 'r', name: 'all', a: '*', mode: 'hard' }],
      { exclusions },
    );

    // Both door occurrences physically overlap the wall (each box spans a
    // full unit past the wall's face), but the void/host exclusion between
    // wallId and doorId must cover EACH occurrence, not just whichever one
    // happened to be bucketed first.
    expect(result.clashes).toHaveLength(0);
  });
});
