/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Spatial chunk bucketing config for the renderer scene (issue #1682,
 * phase 2 of the chunked-residency plan).
 *
 * ON BY DEFAULT (32 m cells) since the #1682 sweep: load KPIs unchanged
 * within noise (FZK/DigitalHub/advanced_model), draw calls 13->17 / 21->85 /
 * 275->343, and chunked batches are what give frustum/contribution culling,
 * the residency budgets and LOD their granularity. Kill switch / override,
 * read once at renderer init (benchmark A/B env VIEWER_BENCHMARK_CHUNKS):
 *   globalThis.__IFC_LITE_CHUNKS = 0                 // off (kill switch)
 *   globalThis.__IFC_LITE_CHUNKS = 16                // on, 16 m cells
 *   globalThis.__IFC_LITE_CHUNKS = { cellSize: 16 }  // same, explicit
 */

import { DEFAULT_CHUNK_CELL_SIZE, type SpatialChunkingConfig } from '@ifc-lite/renderer';

export function getSpatialChunkingConfig(): SpatialChunkingConfig | null {
  const raw = (globalThis as { __IFC_LITE_CHUNKS?: unknown }).__IFC_LITE_CHUNKS;
  if (raw === undefined || raw === null) return { cellSize: DEFAULT_CHUNK_CELL_SIZE };
  if (raw === false || raw === 0) return null;
  if (raw === true || raw === 1) return { cellSize: DEFAULT_CHUNK_CELL_SIZE };
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw > 0 ? { cellSize: raw } : null;
  }
  if (typeof raw === 'object') {
    const cellSize = (raw as { cellSize?: unknown }).cellSize;
    if (typeof cellSize === 'number' && Number.isFinite(cellSize) && cellSize > 0) {
      return { cellSize };
    }
    return null;
  }
  console.warn('[spatialChunkConfig] ignoring invalid __IFC_LITE_CHUNKS:', raw);
  return null;
}
