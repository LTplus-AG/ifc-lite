// SPDX-License-Identifier: MPL-2.0
import type { RetainedProductOutcome } from '../../../wasm/pkg-retained/ifc-lite.js';
import type { RetainedEngine } from './engine.js';
import { partVolume } from './obj.js';

export function retainedReport(engine: RetainedEngine, outcomes: RetainedProductOutcome[], globalId: (id: number) => string | null, ids?: Uint32Array) {
  const byCode: Record<string, number> = {};
  const products = [...outcomes].sort((a, b) => a.expressId - b.expressId).map(p => {
    const common = { id: p.expressId, globalId: globalId(p.expressId), ifcType: p.ifcType, status: p.status };
    if (p.status === 'refused') {
      byCode[p.code] = (byCode[p.code] ?? 0) + 1;
      return { ...common, code: p.code, origin: p.origin ?? null, ...(p.kernelStatus === undefined ? {} : { kernelStatus: p.kernelStatus }) };
    }
    const parts = p.parts.map(part => ({ vertices: part.positions.length / 3, triangles: part.indices.length / 3,
      curved: part.curved, volumeM3: partVolume(part) }));
    return { ...common, parts, volumeM3: parts.reduce((sum, part) => sum + part.volumeM3, 0),
      obligationsUnmet: p.obligationsUnmet, marker: p.marker };
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
