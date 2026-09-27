/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Openings and wall-hosted doors/windows authored into a parsed store (#6232,
 * M3 builder parity with `IfcCreator.addIfcWallDoor` / `addIfcWallWindow`).
 *
 * The host is the wall of a real Bonsai/IfcOpenShell export (hello-wall.ifc,
 * `#1222`: 10 m × 0.1 m × 3 m, body an IfcIndexedPolyCurve profile) plus an
 * overlay-created slab, so both source and overlay hosts are covered.
 */

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import {
  MutablePropertyView,
  StoreEditor,
  type MutationEntityRef,
  type MutationStoreShape,
} from '@ifc-lite/mutations';
import type { HostAnchor } from './anchor.js';
import { resolveHostAnchor } from './resolve-host.js';
import { resolveSpatialAnchor } from './resolve-anchor.js';
import { addOpeningToStore } from './opening.js';
import { addHostedDoorToStore, addHostedWindowToStore } from './hosted-fill.js';
import { addSlabToStore } from './slab.js';

const SAMPLE = new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url);
const WALL = 1222;
const WALL_PLACEMENT = 1235;
const STOREY = 42;

async function session() {
  const bytes = await readFile(SAMPLE);
  const store = await new IfcParser().parseColumnar(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    { disableWorkerScan: true },
  );
  const view = new MutablePropertyView(null, 'm');
  const editor = new StoreEditor(store, view);
  return { store, view, editor };
}

function created(view: MutablePropertyView, id: number) {
  const entity = view.getNewEntity(id);
  if (!entity) throw new Error(`#${id} was not created`);
  return entity;
}

/** Location of an overlay IfcLocalPlacement: [PlacementRelTo, [x, y, z]]. */
function placementOf(view: MutablePropertyView, placementId: number): [unknown, number[]] {
  const placement = created(view, placementId);
  const axis = created(view, Number(String(placement.attributes[1]).slice(1)));
  const point = created(view, Number(String(axis.attributes[0]).slice(1)));
  return [placement.attributes[0], point.attributes[0] as number[]];
}

function closeTo(actual: number[], expected: number[]): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 9));
}

describe('resolveHostAnchor', () => {
  it('reads placement, containing storey and body bounds of an authored wall', async () => {
    const { store, view } = await session();
    const host = resolveHostAnchor(store, WALL, view);
    expect(host).toMatchObject({ hostId: WALL, hostKind: 'wall', hostPlacementId: WALL_PLACEMENT, storeyId: STOREY });
    closeTo(host.hostBounds!.min, [0, 0, 0]);
    closeTo(host.hostBounds!.max, [10, 0.1, 3]);
  });

  it('refuses a host that is not a wall or slab', async () => {
    const { store, view } = await session();
    expect(() => resolveHostAnchor(store, STOREY, view)).toThrow(/IfcWall and IfcSlab/);
    expect(() => resolveHostAnchor(store, 999_999, view)).toThrow(/does not exist/);
  });
});

describe('addOpeningToStore', () => {
  it('cuts through the wall, placed on the wall, voiding it, not contained', async () => {
    const { store, view, editor } = await session();
    const result = addOpeningToStore(editor, resolveHostAnchor(store, WALL, view), {
      Offset: 8, Sill: 0.5, Width: 1, Height: 1.5,
    });

    const opening = created(view, result.openingId);
    expect(opening.type).toBe('IfcOpeningElement');
    expect(opening.attributes).toHaveLength(9);
    expect(opening.attributes[8]).toBe('.OPENING.');
    expect(opening.attributes[6]).toBe(`#${result.productShapeId}`);

    // Cut = 0.1 m wall + 2 × 50 mm, starting on the +Y side of the body's
    // centre plane (y = 0.05) and running along -Y through it.
    expect(result.cutDepth).toBeCloseTo(0.2, 9);
    const [relTo, location] = placementOf(view, result.placementId);
    expect(relTo).toBe(`#${WALL_PLACEMENT}`);
    closeTo(location, [8, 0.15, 0.5]);
    expect(created(view, result.solidId).attributes[3]).toBeCloseTo(0.2, 9);

    const voids = created(view, result.relVoidsId);
    expect(voids.type).toBe('IfcRelVoidsElement');
    expect(voids.attributes.slice(4)).toEqual([`#${WALL}`, `#${result.openingId}`]);
    expect(view.getNewEntities().some((e) => e.type === 'IfcRelContainedInSpatialStructure')).toBe(false);
  });

  it('refuses a cut shallower than the host, and wall params on a slab', async () => {
    const { store, view, editor } = await session();
    const host = resolveHostAnchor(store, WALL, view);
    expect(() => addOpeningToStore(editor, host, { Offset: 1, Width: 1, Height: 1, CutDepth: 0.05 }))
      .toThrow(/shallower/);
    expect(() => addOpeningToStore(editor, host, { Position: [1, 1], Width: 1, Depth: 1 }))
      .toThrow(/is a wall/);
  });

  it('cuts a slab authored earlier in the same session along +Z around its body', async () => {
    const { store, view, editor } = await session();
    const slab = addSlabToStore(editor, resolveSpatialAnchor(store, STOREY, view), {
      Position: [0, 0, 3], Width: 6, Depth: 4, Thickness: 0.25,
    });
    const host = resolveHostAnchor(store, slab.slabId, view);
    expect(host.hostKind).toBe('slab');
    expect(host.storeyId).toBe(STOREY);

    const result = addOpeningToStore(editor, host, { Position: [2, 1], Width: 0.8, Depth: 0.6 });
    expect(result.cutDepth).toBeCloseTo(0.35, 9);
    const [relTo, location] = placementOf(view, result.placementId);
    expect(relTo).toBe(`#${slab.placementId}`);
    closeTo(location, [2, 1, -0.05]);
    expect(() => addHostedDoorToStore(editor, host, { Offset: 1, Width: 1, Height: 2 })).toThrow(/hosted in walls/);
  });
});

describe('addHostedDoorToStore / addHostedWindowToStore', () => {
  it('fills a new opening with a door placed in it and contained in the host storey', async () => {
    const { store, view, editor } = await session();
    const result = addHostedDoorToStore(editor, resolveHostAnchor(store, WALL, view), {
      Offset: 8, Width: 0.9, Height: 2.1, Name: 'Entrance', OperationType: 'SINGLE_SWING_RIGHT',
    });

    const door = created(view, result.fillingId);
    expect(door.type).toBe('IfcDoor');
    expect(door.attributes[2]).toBe('Entrance');
    expect(door.attributes.slice(8)).toEqual([2.1, 0.9, '.NOTDEFINED.', '.SINGLE_SWING_RIGHT.', null]);
    expect(created(view, result.opening.openingId).attributes[2]).toBe('Entrance Opening');

    const fills = created(view, result.relFillsId);
    expect(fills.type).toBe('IfcRelFillsElement');
    expect(fills.attributes.slice(4)).toEqual([`#${result.opening.openingId}`, `#${result.fillingId}`]);
    expect(created(view, result.relContainedId).attributes.slice(4)).toEqual([[`#${result.fillingId}`], `#${STOREY}`]);

    // Relative to the opening, half the cut in: the wall's centre plane.
    const [relTo, location] = placementOf(view, result.placementId);
    expect(relTo).toBe(`#${result.opening.placementId}`);
    closeTo(location, [0, 0, 0.1]);
  });

  it('hosts a window at its sill with the IFC4 partitioning tail', async () => {
    const { store, view, editor } = await session();
    const result = addHostedWindowToStore(editor, resolveHostAnchor(store, WALL, view), {
      Offset: 7.5, Sill: 0.9, Width: 1.2, Height: 1.4, PartitioningType: 'DOUBLE_PANEL_VERTICAL',
    });
    const window = created(view, result.fillingId);
    expect(window.type).toBe('IfcWindow');
    expect(window.attributes.slice(8)).toEqual([1.4, 1.2, '.NOTDEFINED.', '.DOUBLE_PANEL_VERTICAL.', null]);
    closeTo(placementOf(view, result.opening.placementId)[1], [7.5, 0.15, 0.9]);
  });
});

describe('schema and unit handling', () => {
  function syntheticHost(overrides: Partial<HostAnchor>): { editor: StoreEditor; view: MutablePropertyView; host: HostAnchor } {
    const byId = new Map<number, MutationEntityRef>();
    for (let id = 1; id <= 20; id++) byId.set(id, { expressId: id, type: 'IFCDUMMY', byteOffset: 0, byteLength: 1, lineNumber: id });
    const store: MutationStoreShape = { entityIndex: { byId } };
    const view = new MutablePropertyView(null, 'm');
    const host: HostAnchor = {
      ownerHistoryId: 1, bodyContextId: 2, axisContextId: 3, storeyId: 4, storeyPlacementId: 5,
      hostId: 6, hostKind: 'wall', hostPlacementId: 7,
      hostBounds: { min: [0, -100, 0], max: [5000, 100, 3000] },
      ...overrides,
    };
    return { editor: new StoreEditor(store, view), view, host };
  }

  it('drops IfcOpeningElement.PredefinedType and the IfcDoor tail for IFC2X3', () => {
    const { editor, view, host } = syntheticHost({ schema: 'IFC2X3', lengthUnitScale: 0.001 });
    const result = addHostedDoorToStore(editor, host, { Offset: 1, Width: 0.9, Height: 2.1 });
    expect(created(view, result.opening.openingId).attributes).toHaveLength(8);
    expect(created(view, result.fillingId).attributes).toHaveLength(10);
  });

  it('keeps the IFC4 layout for IFC4X3 and converts metre params to millimetres', () => {
    const { editor, view, host } = syntheticHost({ schema: 'IFC4X3', lengthUnitScale: 0.001 });
    const result = addHostedDoorToStore(editor, host, { Offset: 1, Width: 0.9, Height: 2.1 });
    expect(created(view, result.opening.openingId).attributes[8]).toBe('.OPENING.');
    expect(created(view, result.fillingId).attributes.slice(8, 10)).toEqual([2100, 900]);
    expect(result.opening.cutDepth).toBeCloseTo(300, 6);
    closeTo(placementOf(view, result.opening.placementId)[1], [1000, 150, 0]);
  });

  it('asks for CutDepth when the host body cannot be bounded', () => {
    const { editor, host } = syntheticHost({ hostBounds: null });
    expect(() => addOpeningToStore(editor, host, { Offset: 1, Width: 1, Height: 1 })).toThrow(/pass CutDepth/);
    expect(addOpeningToStore(editor, host, { Offset: 1, Width: 1, Height: 1, CutDepth: 0.4 }).cutDepth).toBe(0.4);
  });
});
