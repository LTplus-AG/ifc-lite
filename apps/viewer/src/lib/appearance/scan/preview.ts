/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MeshData } from '@ifc-lite/geometry';
import type { ScanPoint, ScanRegistrationReport } from './types';
import { registeredPoint } from './landmarks';

/** Preview-local Y-up about the target anchor; never modify canonical geometry. */
export function scanPreviewPoint(report: ScanRegistrationReport, point: ScanPoint, source: boolean) {
  const p = source ? registeredPoint(report, point) : point;
  return { x: p[0] - report.targetAnchor[0], y: p[2] - report.targetAnchor[2], z: -(p[1] - report.targetAnchor[1]) };
}
export function alignedScanPreview(mesh: MeshData, report: ScanRegistrationReport): MeshData {
  const positions = new Float32Array(mesh.positions.length), normals = new Float32Array(mesh.normals.length);
  for (let i = 0; i < positions.length; i += 3) {
    const p = scanPreviewPoint(report, [mesh.positions[i] + (mesh.origin?.[0] ?? 0), mesh.positions[i + 1] + (mesh.origin?.[1] ?? 0), mesh.positions[i + 2] + (mesh.origin?.[2] ?? 0)], true);
    positions.set([p.x, p.y, p.z], i);
    const n = report.rotation.map(row => row[0] * mesh.normals[i] + row[1] * mesh.normals[i + 1] + row[2] * mesh.normals[i + 2]);
    normals.set([n[0], n[2], -n[1]], i);
  }
  return { ...mesh, positions, normals, origin: [0, 0, 0] };
}
