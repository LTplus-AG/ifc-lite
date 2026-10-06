/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Test-only seed for assistant artifact reviews (viewer AI P13): the committed
 * `building-architecture.ifc` sample (IFC4, SketchUp-authored: 4 walls with
 * Qto_WallBaseQuantities, 3 slabs with Qto_SlabBaseQuantities, one slab
 * carrying Pset_SlabCommon.FireRating, millimetre lengths and m² areas), and
 * optionally `hello-wall.ifc` federated beside it, parsed by the real parser
 * into the singleton store. No geometry is meshed.
 */

import { readFileSync } from 'node:fs';
import type { GeometryResult } from '@ifc-lite/geometry';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore, type FederatedModel } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';

export const ARCH = 'arch';
export const WALL = 'wall';
const samples = new URL('../../public/samples/', import.meta.url);

async function parse(file: string): Promise<IfcDataStore> {
  const bytes = readFileSync(new URL(file, samples));
  return new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { disableWorkerScan: true });
}

const geometry = {
  meshes: [], totalTriangles: 0, totalVertices: 0,
  coordinateInfo: { originShift: { x: 0, y: 0, z: 0 }, originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
    shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } }, hasLargeCoordinates: false },
} as unknown as GeometryResult;

function model(id: string, name: string, store: IfcDataStore, idOffset: number): FederatedModel {
  let maxExpressId = 0;
  // @raw-entity-enumeration-ok test fixture sizes the federation id range of a freshly parsed source before any mutation view exists
  for (let i = 0; i < store.entities.count; i++) maxExpressId = Math.max(maxExpressId, store.entities.expressId[i]);
  return { ...fixtureModel(id, { idOffset }), name, ifcDataStore: store, geometryResult: geometry, maxExpressId,
    sourceFingerprint: `fixture:${id}` } as unknown as FederatedModel;
}

/** Seed the store with the architecture sample (and the hello-wall sample when `federated`). */
export async function seedArtifactModels(options: { federated?: boolean } = {}): Promise<void> {
  const loaded = [model(ARCH, 'building-architecture.ifc', await parse('building-architecture.ifc'), 0)];
  if (options.federated) loaded.push(model(WALL, 'hello-wall.ifc', await parse('hello-wall.ifc'), 1_000_000));
  useViewerStore.setState({ ...fixtureModels(...loaded), geometryResult: geometry, mutationViews: new Map(), mutationVersion: 0 });
}
