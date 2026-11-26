/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A2UI tests run against the real viewer backend: the committed
 * `building-architecture.ifc` sample parsed and loaded into the store, read
 * through `LocalBackend` and `createBimViewerHost`. `federated` loads the same
 * file twice under two model ids, so every express id exists in both models,
 * which is exactly the case model-aware refs exist for.
 */

import { readFileSync } from 'node:fs';
import { createBimContext, type BimContext } from '@ifc-lite/sdk';
import type { GeometryResult } from '@ifc-lite/geometry';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore, type FederatedModel } from '@/store';
import { LocalBackend } from '@/sdk/local-backend';
import { createBimViewerHost, type A2uiViewerHost } from '@/lib/a2ui/host';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';

export const MODEL_A = 'arch-a';
export const MODEL_B = 'arch-b';
const OFFSET_B = 1_000_000;
const sample = new URL('../../public/samples/building-architecture.ifc', import.meta.url);

let parsed: Promise<IfcDataStore> | undefined;
function parseSample(): Promise<IfcDataStore> {
  parsed ??= (async () => {
    const bytes = readFileSync(sample);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return new IfcParser().parseColumnar(buffer, { disableWorkerScan: true });
  })();
  return parsed;
}

const geometry = {
  meshes: [], totalTriangles: 0, totalVertices: 0,
  coordinateInfo: { originShift: { x: 0, y: 0, z: 0 }, originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
    shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } }, hasLargeCoordinates: false },
} as unknown as GeometryResult;

function model(id: string, store: IfcDataStore, idOffset: number): FederatedModel {
  let maxExpressId = 0;
  // @raw-entity-enumeration-ok test fixture sizes the federation id range of a freshly parsed source before any mutation view exists
  for (let i = 0; i < store.entities.count; i++) maxExpressId = Math.max(maxExpressId, store.entities.expressId[i]);
  return { ...fixtureModel(id, { idOffset }), name: `${id}.ifc`, ifcDataStore: store, geometryResult: geometry, maxExpressId,
    sourceFingerprint: `fixture:${id}` } as unknown as FederatedModel;
}

export interface A2uiFixture {
  bim: BimContext;
  host: A2uiViewerHost;
}

/** Seed the store with the sample (twice when `federated`) and return a host over the real backend. */
export async function seedA2uiModels(options: { federated?: boolean } = {}): Promise<A2uiFixture> {
  const store = await parseSample();
  const loaded = [model(MODEL_A, store, 0)];
  if (options.federated) loaded.push(model(MODEL_B, store, OFFSET_B));
  useViewerStore.setState({ ...fixtureModels(...loaded), geometryResult: geometry, mutationViews: new Map(), mutationVersion: 0 });
  useViewerStore.getState().clearEntitySelection();
  const bim = createBimContext({ backend: new LocalBackend(useViewerStore) });
  return { bim, host: createBimViewerHost(bim) };
}

/** The selection as `"modelId:expressId"` strings, read from the store's model-aware channel. */
export function selectedRefs(host: A2uiViewerHost): string[] {
  return host.getSelection().map((r) => `${r.modelId}:${r.expressId}`).sort();
}
