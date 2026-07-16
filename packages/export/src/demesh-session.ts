/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * DemeshSession — interactive selective mesh simplification with deferred
 * IFC export (the "demesher").
 *
 * Workflow (one session per loaded model):
 *   1. `simplify(expressIds)` — each call escalates the selection one level
 *      (1-4 = cavity removal + vertex-clustering decimation at
 *      0.5/0.25/0.10/0.03 triangle ratio, 5 = bounding box). Simplification
 *      ALWAYS re-runs from the ORIGINAL meshes at the new level — quality
 *      never degrades cumulatively, and `reset()` is trivial. The returned
 *      render meshes go straight into the scene:
 *      `scene.removeMeshesForEntities(ids)` + `scene.addMeshes(renderMeshes)`.
 *   2. `exportIfc()` — separately, when the user is done: loads the original
 *      bytes into a store, swaps each simplified element's representation
 *      for an `IfcTriangulatedFaceSet` (via `applySimplifiedGeometry`),
 *      prunes the orphaned geometry, and writes the lighter IFC. IFC2X3
 *      sources are upconverted to IFC4 first (`IfcTriangulatedFaceSet` is
 *      IFC4+).
 *
 * The model file is parsed at most twice per session (once for meshes unless
 * the caller supplies the ones it already holds, once at export); button
 * presses between those touch only mesh data in wasm.
 */

import {
  GeometryProcessor,
  type MeshData,
  type SimplifiedElementMesh,
} from '@ifc-lite/geometry';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from './step-exporter.js';
import {
  applySimplifiedGeometry,
  type DemeshApplyReport,
  type SimplifiedElementGeometry,
} from './demesh-writer.js';

export interface DemeshSessionOptions {
  /**
   * Already-produced meshes for this model (the viewer's `MeshData[]`) —
   * supply them together with `originShift` from the load's
   * `coordinateInfo` to skip the session's own meshing pass. When omitted,
   * the session meshes the bytes itself on first use.
   */
  meshes?: MeshData[];
  /** `coordinateInfo.originShift` of the load that produced `meshes`. */
  originShift?: { x: number; y: number; z: number };
  /** Metres per project length unit; extracted from the file when omitted. */
  unitScale?: number;
  /** Reuse the app's initialized GeometryProcessor instead of creating one. */
  geometryProcessor?: GeometryProcessor;
}

export interface DemeshSimplifyResult {
  /** Replacement render meshes for the scene (one per simplified element). */
  renderMeshes: MeshData[];
  /** Per-element outcome, including the level now applied. */
  elements: Array<{
    expressId: number;
    level: number;
    trisBefore: number;
    trisAfter: number;
    cavitiesDropped: number;
  }>;
  /** Elements that could not be simplified (keep their original meshes). */
  skipped: Array<{ expressId: number; reason: string }>;
}

export interface DemeshExportResult {
  bytes: Uint8Array;
  report: DemeshApplyReport;
  /** True when an IFC2X3 source was upconverted to IFC4 for the export. */
  upconverted: boolean;
  bytesBefore: number;
  bytesAfter: number;
}

export class DemeshSession {
  private readonly source: Uint8Array;
  private readonly options: DemeshSessionOptions;
  private gp: GeometryProcessor | null = null;
  private ownsGp = false;
  private meshes: MeshData[] | null = null;
  private originShift: { x: number; y: number; z: number };
  private unitScale: number | null;
  /** expressId -> state of the CURRENT simplification (from-original). */
  private readonly applied = new Map<number, SimplifiedElementMesh>();

  constructor(source: Uint8Array | ArrayBuffer, options: DemeshSessionOptions = {}) {
    this.source = source instanceof Uint8Array ? source : new Uint8Array(source);
    this.options = options;
    this.meshes = options.meshes ?? null;
    this.originShift = options.originShift ?? { x: 0, y: 0, z: 0 };
    this.unitScale = options.unitScale ?? null;
  }

  /** The level currently applied to an element (0 = untouched). */
  levelOf(expressId: number): number {
    return this.applied.get(expressId)?.level ?? 0;
  }

  /** Express ids currently carrying simplified geometry. */
  simplifiedIds(): number[] {
    return [...this.applied.keys()];
  }

  /**
   * Simplify `expressIds` at `level`, or — when `level` is omitted — one
   * level past each element's current one (the button behavior: press,
   * press again, ...; capped at 5).
   */
  async simplify(expressIds: number[], level?: number): Promise<DemeshSimplifyResult> {
    const meshes = await this.ensureMeshes();
    const unitScale = await this.ensureUnitScale();
    const gp = await this.ensureProcessor();

    const levels = new Map<number, number>();
    for (const id of expressIds) {
      levels.set(id, Math.min(5, level ?? this.levelOf(id) + 1));
    }
    const targetIds = new Set(levels.keys());
    // Always simplify from the ORIGINAL records of the selection.
    const records = meshes.filter((m) => targetIds.has(m.expressId));

    const out = gp.simplifyMeshes(records, levels, {
      originShift: this.originShift,
      unitScale,
    });
    if (!out) {
      throw new Error('DemeshSession.simplify: geometry processor is not initialized');
    }

    const result: DemeshSimplifyResult = { renderMeshes: [], elements: [], skipped: out.skipped };
    for (const el of out.elements) {
      this.applied.set(el.expressId, el);
      result.renderMeshes.push(el.render);
      result.elements.push({
        expressId: el.expressId,
        level: el.level,
        trisBefore: el.trisBefore,
        trisAfter: el.trisAfter,
        cavitiesDropped: el.cavitiesDropped,
      });
    }
    return result;
  }

  /**
   * Forget the simplification state for `expressIds` (all when omitted).
   * The caller restores the elements' original meshes in the scene.
   */
  reset(expressIds?: number[]): void {
    if (!expressIds) {
      this.applied.clear();
      return;
    }
    for (const id of expressIds) this.applied.delete(id);
  }

  /**
   * The `n` heaviest elements by triangle count — demesh candidates for the
   * UI. Requires meshes (supplied or produced on first `simplify`).
   */
  async heaviest(n: number): Promise<Array<{ expressId: number; triangles: number }>> {
    const meshes = await this.ensureMeshes();
    const byElement = new Map<number, number>();
    for (const m of meshes) {
      if ((m.geometryClass ?? 0) !== 0) continue;
      byElement.set(m.expressId, (byElement.get(m.expressId) ?? 0) + m.indices.length / 3);
    }
    return [...byElement.entries()]
      .map(([expressId, triangles]) => ({ expressId, triangles }))
      .sort((a, b) => b.triangles - a.triangles)
      .slice(0, Math.max(0, n));
  }

  /**
   * Write the lighter IFC: original bytes + tessellated replacements for
   * every currently simplified element. Does not mutate session state — the
   * user can keep simplifying and export again.
   */
  async exportIfc(): Promise<DemeshExportResult> {
    if (this.applied.size === 0) {
      throw new Error('DemeshSession.exportIfc: nothing simplified yet');
    }

    // Load (and upconvert when needed) the store the mutations apply to.
    let sourceBytes = this.source;
    let upconverted = false;
    let store = await new IfcParser().parseColumnar(toArrayBuffer(sourceBytes), {
      disableWorkerScan: true,
    });
    if ((store.schemaVersion ?? 'IFC4').toUpperCase() === 'IFC2X3') {
      // IfcTriangulatedFaceSet is IFC4+. The schema conversion is a
      // line-faithful rewrite (express ids preserved), so the session's
      // element ids stay valid against the converted buffer.
      const converted = new StepExporter(store).export({ schema: 'IFC4' });
      sourceBytes = converted.content;
      store = await new IfcParser().parseColumnar(toArrayBuffer(sourceBytes), {
        disableWorkerScan: true,
      });
      upconverted = true;
    }

    const view = new MutablePropertyView(null, 'default');
    const editor = new StoreEditor(store, view);
    const elements: SimplifiedElementGeometry[] = [...this.applied.values()].map((el) => ({
      expressId: el.expressId,
      positions: el.localPositions,
      indices: el.localIndices,
      color: el.render.color,
    }));
    const report = applySimplifiedGeometry(store, editor, elements);

    const schema = ((store.schemaVersion ?? 'IFC4').toUpperCase() === 'IFC2X3' ? 'IFC4' : (store.schemaVersion ?? 'IFC4')) as
      | 'IFC4'
      | 'IFC4X3'
      | 'IFC5';
    const result = new StepExporter(store, view).export({ schema, applyMutations: true });
    return {
      bytes: result.content,
      report,
      upconverted,
      bytesBefore: this.source.byteLength,
      bytesAfter: result.content.byteLength,
    };
  }

  /** Release the session's own GeometryProcessor (a shared one is untouched). */
  destroy(): void {
    if (this.ownsGp && this.gp) {
      this.gp.dispose();
    }
    this.gp = null;
    this.meshes = null;
    this.applied.clear();
  }

  private async ensureProcessor(): Promise<GeometryProcessor> {
    if (this.gp) return this.gp;
    if (this.options.geometryProcessor) {
      this.gp = this.options.geometryProcessor;
      return this.gp;
    }
    this.gp = new GeometryProcessor();
    this.ownsGp = true;
    await this.gp.init();
    return this.gp;
  }

  private async ensureMeshes(): Promise<MeshData[]> {
    if (this.meshes) return this.meshes;
    const gp = await this.ensureProcessor();
    const meshes: MeshData[] = [];
    for await (const event of gp.processAdaptive(this.source, { sizeThreshold: 0 })) {
      if (event.type === 'batch') {
        meshes.push(...event.meshes);
        if (event.coordinateInfo) this.originShift = event.coordinateInfo.originShift;
      } else if (event.type === 'complete' && event.coordinateInfo) {
        this.originShift = event.coordinateInfo.originShift;
      }
    }
    this.meshes = meshes;
    return meshes;
  }

  private async ensureUnitScale(): Promise<number> {
    if (this.unitScale !== null) return this.unitScale;
    const { scanIfcEntities, extractLengthUnitScale } = await import('@ifc-lite/parser');
    const { entityRefs } = await scanIfcEntities(toArrayBuffer(this.source));
    const byId = new Map<number, (typeof entityRefs)[number]>();
    const byType = new Map<string, number[]>();
    for (const ref of entityRefs) {
      byId.set(ref.expressId, ref);
      const type = String(ref.type || '').toUpperCase();
      const list = byType.get(type);
      if (list) list.push(ref.expressId);
      else byType.set(type, [ref.expressId]);
    }
    this.unitScale = extractLengthUnitScale(this.source, { byId, byType });
    return this.unitScale;
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer) {
    return bytes.buffer;
  }
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}
