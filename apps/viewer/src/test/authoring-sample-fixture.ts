/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Test-only seed for reviewed authoring (P15A): the committed SketchUp-authored
 * `building-architecture.ifc` sample (IFC4, millimetres, wall types and
 * materials) loaded into the singleton store with Edit mode on, an empty
 * geometry result, and a scripted re-mesh worker that records requests and
 * never answers, so nothing reaches wasm.
 */

import '@/lib/placement-edit.boot';
import { readFileSync } from 'node:fs';
import type { GeometryResult } from '@ifc-lite/geometry';
import type { RemeshRequest, RemeshResult, StyleWire } from '@ifc-lite/geometry/remesh';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore, type FederatedModel } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { setRemeshClientFactory, type RemeshClientLike } from '@/lib/remesh/remesh-service';

export const SAMPLE_MODEL = 'arch';
/** `00 groundfloor`. */
export const GROUND_STOREY = '1Ano2ZUxnEIvVQ_beukl8b';
/** IfcWall `house - outer wall - house right back` (#291), typed by #289. */
export const BACK_WALL = '3wdauVJT5Fx9drrREiDqA$';
export const BACK_WALL_NAME = 'house - outer wall - house right back';
/** IfcWallType `house - outer wall - house right front` (#260). */
export const FRONT_WALL_TYPE = '2YJwrhcCv9v8UXU8cWK40m';
export const FRONT_WALL_TYPE_NAME = 'house - outer wall - house right front';
/** IfcWall `plumbing wall` (#353). */
export const PLUMBING_WALL = '1uS5vfZPn9R8PlAaVd73on';

const sample = new URL('../../public/samples/building-architecture.ifc', import.meta.url);

export const remeshRequests: RemeshRequest[] = [];

class ScriptedClient implements RemeshClientLike {
  alive = true;
  remesh(request: RemeshRequest): Promise<RemeshResult> { remeshRequests.push(request); return new Promise(() => {}); }
  styleWire(): Promise<StyleWire> {
    return Promise.resolve({ styleIds: new Uint32Array(), styleColors: new Uint8Array(), materialElementIds: new Uint32Array(),
      materialColorCounts: new Uint32Array(), materialColors: new Uint8Array() });
  }
  setConfig(): void {}
  dispose(): void { this.alive = false; }
}

export async function parseIfc(bytes: Uint8Array): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { disableWorkerScan: true });
}

export async function seedAuthoringSample(options: { editEnabled?: boolean } = {}): Promise<{ dataStore: IfcDataStore; view: MutablePropertyView }> {
  const dataStore = await parseIfc(readFileSync(sample));
  const geometry = {
    meshes: [], totalTriangles: 0, totalVertices: 0,
    coordinateInfo: { originShift: { x: 0, y: 0, z: 0 }, originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
      shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } }, hasLargeCoordinates: false },
  } as unknown as GeometryResult;
  const model = { ...fixtureModel(SAMPLE_MODEL), ifcDataStore: dataStore, geometryResult: geometry } as unknown as FederatedModel;
  const view = new MutablePropertyView(dataStore.properties || null, SAMPLE_MODEL);
  remeshRequests.length = 0;
  setRemeshClientFactory(async () => new ScriptedClient());
  useViewerStore.setState({
    ...fixtureModels(model), geometryResult: geometry, editEnabled: options.editEnabled ?? true, collabRole: null, collabRoomId: null,
    mutationViews: new Map([[SAMPLE_MODEL, view]]), storeEditors: new Map(), undoStacks: new Map(), redoStacks: new Map(),
    mutationBatchTags: new Map(), removedNewEntities: new Map(), removedMeshes: new Map(), pendingMeshRemovals: null,
    dirtyModels: new Set(), geometryContentVersion: 0, mutationVersion: 0,
  });
  return { dataStore, view };
}

/** `#n` references in a STEP text that name no entity: referential integrity of an export. */
export function danglingReferences(step: string): number[] {
  const defined = new Set<number>();
  for (const match of step.matchAll(/^#(\d+)\s*=/gm)) defined.add(Number(match[1]));
  const dangling = new Set<number>();
  for (const line of step.split('\n')) {
    const body = line.replace(/^#\d+\s*=/, '').replace(/'(?:[^']|'')*'/g, '');
    for (const match of body.matchAll(/#(\d+)/g)) if (!defined.has(Number(match[1]))) dangling.add(Number(match[1]));
  }
  return [...dangling];
}
