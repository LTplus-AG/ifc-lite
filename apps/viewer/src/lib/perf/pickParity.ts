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
  /** True for an id the viewer draws as an annotation overlay (IfcAnnotation, IfcGrid, IfcGridAxis). */
  isAnnotationOwner: (globalId: number) => boolean;
  /** A marquee in pick texels (inclusive) to compare with the CPU raycast at every texel centre inside it. */
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
  /**
   * `renderer.pick` also answers annotation overlays (grid axes, symbolic
   * lines) on the CPU. A hit counts as one only when its id owns no mesh AND
   * names an annotation-type entity; any other id stays in the mesh parity.
   * Reported, kept out of mesh parity.
   */
  annotation: boolean;
  gpu: PickParityHit | null;
  cpu: PickParityHit | null;
  /** GPU world point to CPU hit point, metres; null unless both hit. */
  distanceMetres: number | null;
}

export interface PickParityReport {
  /** Pick texture size (the canvas CSS size, rounded). */
  canvas: { width: number; height: number };
  batches: { total: number; quantized: number };
  /** Hydrated individual pick meshes before and after the grid: unchanged on the batch route. */
  hydratedMeshes: { before: number; after: number };
  /** Visible flat pieces: above 500, `pick` draws the batches instead of hydrating. */
  visiblePieces: number;
  rows: PickParityRow[];
  /** The marquee's ids, and a click plus CPU raycast at every texel it covers. */
  rect?: { gpu: number[]; texels: PickParityRow[] };
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
  // The pick pass renders at the rounded CSS size and reads texel floor(x * scale);
  // the CPU raycast unprojects x over the fractional CSS rect. Sampling at
  // (texel + 0.5) / scale puts both at the same NDC: the texel centre.
  const css = renderer.getCanvas().getBoundingClientRect();
  const width = Math.max(1, Math.round(css.width));
  const height = Math.max(1, Math.round(css.height));
  const toCssX = (texel: number) => (texel + 0.5) * (css.width / width);
  const toCssY = (texel: number) => (texel + 0.5) * (css.height / height);
  const scene = renderer.getScene();
  const batches = scene.getBatchedMeshes();
  const before = hydrated(renderer);
  const sample = async (tx: number, ty: number): Promise<PickParityRow> => {
    const x = toCssX(tx), y = toCssY(ty);
    const gpu = await renderer.pick(x, y, request.options);
    const cpu = renderer.raycastScene(x, y, request.options)?.intersection ?? null;
    const g = gpu?.worldXYZ;
    return {
      x, y,
      annotation: gpu !== null && !scene.hasMeshData(gpu.expressId) && !scene.isInstancedEntity(gpu.expressId)
        && request.isAnnotationOwner(gpu.expressId),
      gpu: gpu ? hit(gpu, g) : null,
      cpu: cpu ? hit(cpu, cpu.point) : null,
      distanceMetres: g && cpu ? Math.hypot(g.x - cpu.point.x, g.y - cpu.point.y, g.z - cpu.point.z) : null,
    };
  };
  const rows: PickParityRow[] = [];
  for (let r = 0; r < request.rows; r++) {
    for (let c = 0; c < request.columns; c++) {
      rows.push(await sample(Math.floor(((c + 0.5) / request.columns) * width), Math.floor(((r + 0.5) / request.rows) * height)));
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
    // Texel bounds, as the picker floors them; CSS corners at those texel centres.
    // Every texel inside is also clicked and raycast, so the marquee is checked
    // texel by texel rather than as bare id sets (coincident surfaces tie).
    const { x0, y0, x1, y1 } = request.rect;
    const gpu = await renderer.pickRect(toCssX(x0), toCssY(y0), toCssX(x1), toCssY(y1), request.options);
    const texels: PickParityRow[] = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) texels.push(await sample(x, y));
    report.rect = { gpu: [...gpu].sort((a, b) => a - b), texels };
  }
  return report;
}
