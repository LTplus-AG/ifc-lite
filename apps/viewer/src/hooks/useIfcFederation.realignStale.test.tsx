/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A stale realignment restores its own geometry, but that is not permission
 * for the hook to publish a new placement frame, invalidate GPU geometry, or
 * retarget independent point-cloud assets. This drives the hook through its
 * real alignment await and replaces the anchor record in between (#5048).
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CoordinateInfo, GeometryResult, MeshData } from '@ifc-lite/geometry';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import { useViewerStore, type FederatedModel } from '@/store';
import { spatialReferenceFromIfc } from '../lib/geo/ifc-spatial-reference.js';
import { useIfcFederation } from './useIfcFederation.js';

function coordinateInfo(): CoordinateInfo {
  return {
    originShift: { x: 0, y: 0, z: 0 },
    originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
    shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
    hasLargeCoordinates: false,
  };
}

function spatialReference(crsName: string, eastings = 0) {
  return spatialReferenceFromIfc({
    mapConversion: {
      id: 1, sourceCRS: 2, targetCRS: 3, eastings, northings: 0,
      orthogonalHeight: 0, xAxisAbscissa: 1, xAxisOrdinate: 0, scale: 1,
    } as MapConversion,
    projectedCRS: {
      id: 4, name: crsName, verticalDatum: 'EPSG:5729', mapUnitScale: 1,
    } as ProjectedCRS,
    lengthUnitScale: 1,
  });
}

function mesh(expressId: number): MeshData {
  return {
    expressId,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    color: [1, 1, 1, 1],
    geometryHash: BigInt(expressId),
  };
}

function model(id: string, loadedAt: number, crsName: string, eastings = 0): FederatedModel {
  const meshes = [mesh(loadedAt)];
  const geometryResult: GeometryResult = {
    meshes,
    totalVertices: 3,
    totalTriangles: 1,
    coordinateInfo: coordinateInfo(),
  };
  return {
    id,
    name: id,
    ifcDataStore: null,
    geometryResult,
    spatialReference: spatialReference(crsName, eastings),
    visible: true,
    collapsed: false,
    schemaVersion: 'IFC4',
    loadedAt,
    fileSize: 0,
    idOffset: 0,
    maxExpressId: loadedAt,
  };
}

let hookApi: ReturnType<typeof useIfcFederation> | null = null;
const loadFile: Parameters<typeof useIfcFederation>[0] = async () => {};

function Probe(): null {
  hookApi = useIfcFederation(loadFile);
  return null;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
beforeEach(async () => {
  useViewerStore.getState().resetViewerState();
  hookApi = null;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Probe />);
  });
});

afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  if (container) container.remove();
  container = null;
});

describe('useIfcFederation — stale realignment publication fence (#5048)', () => {
  it('does not publish a frame or geometry invalidation after the realignment transaction returns stale', async () => {
    useViewerStore.getState().addModel(model('X', 1, 'EPSG:2056'));
    useViewerStore.getState().addModel(model('B', 2, 'EPSG:2056', 100));

    const beforePublish = useViewerStore.getState();
    await act(async () => {
      const pending = hookApi!.realignFederation();
      // The transaction enters through its serialization microtask, commits
      // the anchor, then `await`s even a same-CRS alignment. Queue this after
      // the call: it lands exactly in that await and preserves the anchor's
      // geometry while replacing its immutable display record.
      queueMicrotask(() => useViewerStore.getState().updateModel('X', { name: 'anchor renamed mid-pass' }));
      await pending;
    });

    // The replacement intentionally retains the anchor geometry. The
    // transaction must return stale, while the old caller would still accept
    // this as a frame-compatible model set and publish below it.
    const after = useViewerStore.getState();

    assert.equal(after.modelPlacement.revision, beforePublish.modelPlacement.revision,
      'a stale transaction must not publish a federation frame for its obsolete anchor');
    assert.equal(after.geometryContentVersion, beforePublish.geometryContentVersion,
      'a stale transaction must not trigger renderer/index invalidation after its rollback');
  });
});
