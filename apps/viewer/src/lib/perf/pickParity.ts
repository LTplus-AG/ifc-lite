/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GPU pick parity probe (#10264 S1), behind `__ifc_lite_pick_parity__`.
 *
 * For a grid of texel centres it runs the production click pick
 * (`renderer.pick`: on a model over the pick-mesh budget, the colour batches
 * drawn whole) and the exact CPU triangle raycast (`renderer.raycastScene`,
 * same clip and visibility) and reports both. The CPU raycast is the oracle:
 * it reads the retained CPU geometry, not the GPU's 1 mm lattice. Nothing here
 * decides pass or fail; the caller states its tolerance.
 */

import type { PickOptions, Renderer } from '@ifc-lite/renderer';

export interface PickParityRequest {
  /** Grid columns and rows over the canvas; samples sit at CSS texel centres. */
  columns: number;
  rows: number;
  options: PickOptions;
  /** A marquee (CSS px) to compare with the CPU raycast at every texel centre inside it. */
  rect?: { x0: number; y0: number; x1: number; y1: number };
}

export interface PickParityHit {
  expressId: number;
  modelIndex?: number;
  geometryItemId?: number;
  world?: [number, number, number];
}

export interface PickParityRow {
  x: number;
  y: number;
  gpu: PickParityHit | null;
  cpu: PickParityHit | null;
  /** GPU world point to CPU hit point, metres; null unless both hit. */
  distanceMetres: number | null;
}

export interface PickParityReport {
  canvas: { width: number; height: number };
  batches: { total: number; quantized: number };
  /** Hydrated individual pick meshes before and after the grid: unchanged on the batch route. */
  hydratedMeshes: { before: number; after: number };
  /** Visible flat pieces: above 500, `pick` draws the batches instead of hydrating. */
  visiblePieces: number;
  rows: PickParityRow[];
  rect?: { gpu: number[]; cpu: number[] };
}

const hit = (h: { expressId: number; modelIndex?: number; geometryItemId?: number }, world?: { x: number; y: number; z: number }): PickParityHit => ({
  expressId: h.expressId,
  ...(h.modelIndex !== undefined ? { modelIndex: h.modelIndex } : {}),
  ...(h.geometryItemId !== undefined ? { geometryItemId: h.geometryItemId } : {}),
  ...(world ? { world: [world.x, world.y, world.z] } : {}),
});

function visiblePieceCount(renderer: Renderer, options: PickOptions): number {
  let pieces = 0;
  renderer.getScene().forEachMeshData((piece) => {
    const id = piece.expressId;
    if (options.hiddenIds?.has(id)) return;
    if (options.isolatedIds && !options.isolatedIds.has(id)) return;
    pieces++;
  });
  return pieces;
}

const hydrated = (renderer: Renderer): number => renderer.getScene().getMeshes().filter((mesh) => mesh.hydrated).length;

/** Run the grid (and the optional marquee) against the current frame. */
export async function runPickParity(renderer: Renderer, request: PickParityRequest): Promise<PickParityReport> {
  const canvas = renderer.getCanvas();
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const batches = renderer.getScene().getBatchedMeshes();
  const before = hydrated(renderer);
  const rows: PickParityRow[] = [];
  for (let r = 0; r < request.rows; r++) {
    for (let c = 0; c < request.columns; c++) {
      const x = Math.floor(((c + 0.5) / request.columns) * width) + 0.5;
      const y = Math.floor(((r + 0.5) / request.rows) * height) + 0.5;
      const gpu = await renderer.pick(x, y, request.options);
      const cpu = renderer.raycastScene(x, y, request.options)?.intersection ?? null;
      const g = gpu?.worldXYZ;
      rows.push({
        x, y,
        gpu: gpu ? hit(gpu, g) : null,
        cpu: cpu ? hit(cpu, cpu.point) : null,
        distanceMetres: g && cpu ? Math.hypot(g.x - cpu.point.x, g.y - cpu.point.y, g.z - cpu.point.z) : null,
      });
    }
  }
  const report: PickParityReport = {
    canvas: { width, height },
    batches: { total: batches.length, quantized: batches.filter((b) => b.quantized).length },
    hydratedMeshes: { before, after: hydrated(renderer) },
    visiblePieces: visiblePieceCount(renderer, request.options),
    rows,
  };
  if (request.rect) {
    const { x0, y0, x1, y1 } = request.rect;
    const gpu = await renderer.pickRect(x0, y0, x1, y1, request.options);
    const cpu = new Set<number>();
    for (let y = Math.floor(y0); y <= Math.floor(y1); y++) {
      for (let x = Math.floor(x0); x <= Math.floor(x1); x++) {
        const id = renderer.raycastScene(x + 0.5, y + 0.5, request.options)?.intersection.expressId;
        if (id !== undefined) cpu.add(id);
      }
    }
    report.rect = { gpu: [...gpu].sort((a, b) => a - b), cpu: [...cpu].sort((a, b) => a - b) };
  }
  return report;
}
