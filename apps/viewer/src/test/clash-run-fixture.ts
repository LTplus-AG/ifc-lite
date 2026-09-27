/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Two coincident walls with real parsed stores and real unit-box meshes, so a
 * Clash panel test runs the REAL detection (`useClash`) instead of seeding a
 * result: at 1 model (both walls in one) or N models (one wall each, the
 * second id-offset as a federation's is). Shared by the Clash re-run test and
 * the analysis-panel consistency matrix (#5834).
 */

import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import type { CoordinateInfo, GeometryResult, MeshData } from '@ifc-lite/geometry';
import { useViewerStore, type FederatedModel } from '@/store';

function ifc4(body: string): string {
  return [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('','',(''),(''),'','','');",
    "FILE_SCHEMA(('IFC4'));",
    'ENDSEC;',
    'DATA;',
    body,
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
}

/** `count` IfcWalls `#1..#count`, each with a distinct 22-character GlobalId. */
function walls(count: number): string {
  return Array.from({ length: count }, (_, i) => {
    const id = i + 1;
    const guid = `0${String(id).padStart(3, '0')}`.padEnd(22, 'a');
    return `#${id}=IFCWALL('${guid}',$,'Wall ${id}',$,$,$,$,$,.STANDARD.);`;
  }).join('\n');
}

async function parse(body: string): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(ifc4(body));
  // disableWorkerScan keeps the scan in-process (no Worker under node:test).
  return new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
}

/** A unit box (12 triangles) with its min corner at `(dx, 0, 0)`. */
function boxMesh(expressId: number, dx: number): MeshData {
  const positions = new Float32Array([
    dx, 0, 0, dx + 1, 0, 0, dx + 1, 1, 0, dx, 1, 0,
    dx, 0, 1, dx + 1, 0, 1, dx + 1, 1, 1, dx, 1, 1,
  ]);
  const indices = new Uint32Array([
    0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6,
    0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2,
    2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0,
  ]);
  return {
    expressId,
    ifcType: 'IfcWall',
    positions,
    normals: new Float32Array(positions.length),
    indices,
    color: [0.5, 0.5, 0.5, 1],
  };
}

function geometry(meshes: MeshData[]): GeometryResult {
  const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 1, z: 1 } };
  const coordinateInfo: CoordinateInfo = {
    originShift: { x: 0, y: 0, z: 0 },
    originalBounds: bounds,
    shiftedBounds: bounds,
    hasLargeCoordinates: false,
  };
  return { meshes, totalTriangles: 12 * meshes.length, totalVertices: 8 * meshes.length, coordinateInfo };
}

function model(id: string, idOffset: number, store: IfcDataStore, meshes: MeshData[]): FederatedModel {
  return {
    id,
    name: `${id}.ifc`,
    ifcDataStore: store,
    geometryResult: geometry(meshes),
    visible: true,
    collapsed: false,
    schemaVersion: 'IFC4',
    loadedAt: 0,
    fileSize: 0,
    idOffset,
    maxExpressId: meshes.length,
  };
}

/**
 * `wallCount` coincident walls (every pair clashes): all in one model, or
 * split across two models, the second id-offset by 100.
 */
export async function seedCoincidentWalls(modelCount: 1 | 2, wallCount = 2): Promise<void> {
  const perModel = modelCount === 1 ? [wallCount] : [Math.ceil(wallCount / 2), Math.floor(wallCount / 2)];
  const models = await Promise.all(perModel.map(async (count, index) => {
    // Meshes carry GLOBAL ids, as the viewer's load path shifts them.
    const idOffset = index * 100;
    const meshes = Array.from({ length: count }, (_, i) => boxMesh(idOffset + i + 1, 0));
    return model(index === 0 ? 'A' : 'B', idOffset, await parse(walls(count)), meshes);
  }));
  useViewerStore.setState({
    models: new Map(models.map((m) => [m.id, m])),
    activeModelId: 'A',
    clashResult: null,
    clashGroups: null,
    clashError: null,
    clashRunning: false,
  });
}
