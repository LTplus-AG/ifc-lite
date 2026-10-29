// SPDX-License-Identifier: MPL-2.0
import type { RetainedProductOutcome } from '../../../wasm/pkg-retained/ifc-lite.js';
import type { RetainedEngine } from './engine.js';
import { partVolume, worldPoints } from './obj.js';

export function retainedReport(engine: RetainedEngine, outcomes: RetainedProductOutcome[], globalId: (id: number) => string | null, ids?: Uint32Array) {
  const byCode: Record<string, number> = {};
  const products = [...outcomes].sort((a, b) => a.expressId - b.expressId).map(p => {
    const common = { id: p.expressId, globalId: globalId(p.expressId), ifcType: p.ifcType, status: p.status };
    if (p.status === 'refused') {
      byCode[p.code] = (byCode[p.code] ?? 0) + 1;
      return { ...common, code: p.code, origin: p.origin ?? null, ...(p.kernelStatus === undefined ? {} : { kernelStatus: p.kernelStatus }) };
    }
    const parts = p.parts.map(part => ({ vertices: part.positions.length / 3, triangles: part.indices.length / 3,
      curved: part.curved, volumeM3: partVolume(part),
      ...(part.color ? { color: part.color } : {}),
      ...(part.materialName === undefined ? {} : { materialName: part.materialName }),
      ...(part.geometryItemId === undefined ? {} : { geometryItemId: part.geometryItemId }),
      ...(part.materialId === undefined ? {} : { materialId: part.materialId }),
      // JSON has no negative zero; canonicalise so the written report round-trips exactly.
      ...(part.normals ? { normals: Array.from(part.normals, v => v + 0) } : {}),
      ...(part.faces ? { faces: faceReport(part) } : {}) }));
    return { ...common, cuts: p.cuts, consumedParts: p.consumedParts, parts, volumeM3: parts.reduce((sum, part) => sum + part.volumeM3, 0),
      obligationsUnmet: p.obligationsUnmet, marker: p.marker,
      ...(p.instanceGroup ? { instanceGroup: p.instanceGroup } : {}) };
  });
  const published = outcomes.filter(p => p.status === 'published').length;
  return { format: 'ifc-lite.retained-report/1',
    engine: { sdk: engine.sdk, manifestSha256: engine.manifestSha256, capabilities: engine.capabilities },
    settings: { kernel: 'retained', chordMetres: 0.001, angleDegrees: 5, maxBytes: 16 * 1024 * 1024,
      maxRestarts: 3, ids: ids ? Array.from(ids).sort((a, b) => a - b) : null },
    summary: { candidates: outcomes.length, published, coverage: outcomes.length ? published / outcomes.length : 0, byCode }, products };
}

/** Stable keys throughout, with products already sorted by numeric id. */
export function reportJson(report: unknown): string {
  return `${JSON.stringify(report, (_key, value: unknown) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    }
    return value;
  }, 2)}\n`;
}

function faceReport(part: import('../../../wasm/pkg-retained/ifc-lite.js').RetainedShapePart) {
  const faces = part.faces;
  if (!faces) return [];
  if (faces.triangles.length !== part.indices.length / 3 || faces.triangles.some(i => i >= faces.table.length)) {
    throw new Error('Invalid retained face table; refusing partial product');
  }
  const points = worldPoints(part);
  const rows = faces.table.map(key => ({ key, triangles: 0, areaM2: 0 }));
  for (let t = 0; t < faces.triangles.length; t++) {
    const [a, b, c] = Array.from(part.indices.subarray(t * 3, t * 3 + 3), i => points[i]);
    const u = b.map((v, i) => v - a[i]), v = c.map((x, i) => x - a[i]);
    const row = rows[faces.triangles[t]];
    row.triangles++;
    row.areaM2 += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
  }
  return rows;
}
