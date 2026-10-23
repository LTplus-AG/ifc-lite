/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IFC terrain → LandXML 1.2, the viewer half (#7600). The producer, and every
 * rule about what qualifies as an exportable terrain, lives in Rust
 * (`rust/export/src/landxml_terrain.rs`, reached through
 * `GeometryProcessor.exportLandXmlTerrain`). This module only:
 *
 *  - narrows the current selection to the products the producer can be asked
 *    about at all (`IfcGeographicElement` / `IfcSite`) in ONE model, and
 *  - runs the producer as the dialog's preflight, classifying its outcome.
 *
 * It deliberately does not re-check "has exactly one triangulated body" or
 * "is georeferenced" in TypeScript: the preflight IS the export, so the
 * dialog offers LandXML exactly when the producer accepts the selection and
 * otherwise shows the producer's own reason.
 */

import { GeometryProcessor, terrainRefusalReason, type LandXmlTerrainExport, type LandXmlTerrainExportOptions } from '@ifc-lite/geometry';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { EntityRef } from '@/store/types';
import { modelExportFilename } from './download';

/** The IFC classes the producer accepts as a terrain carrier. */
const TERRAIN_TYPES = new Set(['IFCGEOGRAPHICELEMENT', 'IFCSITE']);

/** The selection ref id the single-model (non-federated) store uses. */
const LEGACY_MODEL_ID = 'legacy';

/** What the selection resolver needs to know about the loaded models. */
export interface TerrainSelectionInput {
  refs: readonly EntityRef[];
  models: ReadonlyMap<string, { name: string; ifcDataStore: IfcDataStore | null }>;
  /** The single-model store `legacy` refs point at (`state.ifcDataStore`). */
  legacyStore: IfcDataStore | null;
}

/** The selection, narrowed to terrain candidates. `skipped` counts selected objects left out. */
export type TerrainSelection =
  | { kind: 'none'; skipped: number }
  | { kind: 'multiple-models'; skipped: number; modelCount: number }
  | {
      kind: 'ready';
      skipped: number;
      /** Mutation-view key: the federated model id, or `legacy`. */
      modelId: string;
      modelName: string;
      store: IfcDataStore;
      /** Model-local express ids, selection order, deduplicated. */
      productIds: number[];
    };

interface ResolvedModel {
  modelId: string;
  name: string;
  store: IfcDataStore;
}

function resolveRefModel(input: TerrainSelectionInput, modelId: string): ResolvedModel | null {
  if (modelId !== LEGACY_MODEL_ID) {
    const model = input.models.get(modelId);
    return model?.ifcDataStore ? { modelId, name: model.name, store: model.ifcDataStore } : null;
  }
  // A `legacy` ref is a single-model session's id. With no federated model it
  // is the legacy store; with exactly one it can only mean that model.
  if (input.models.size === 0) {
    return input.legacyStore ? { modelId: LEGACY_MODEL_ID, name: '', store: input.legacyStore } : null;
  }
  if (input.models.size === 1) {
    const [soleId, sole] = [...input.models][0];
    return sole.ifcDataStore ? { modelId: soleId, name: sole.name, store: sole.ifcDataStore } : null;
  }
  return null;
}

/**
 * Narrow the current selection (from `getSelectionBaseRefs`) to terrain
 * candidates. Anything that is not an `IfcGeographicElement` or `IfcSite`, or
 * whose model cannot be resolved, is counted in `skipped`.
 */
export function resolveTerrainSelection(input: TerrainSelectionInput): TerrainSelection {
  const byModel = new Map<string, { model: ResolvedModel; ids: number[] }>();
  let skipped = 0;
  for (const ref of input.refs) {
    const model = resolveRefModel(input, ref.modelId);
    const typeName = model?.store.entities.getTypeName(ref.expressId) ?? '';
    if (!model || !TERRAIN_TYPES.has(typeName.toUpperCase())) {
      skipped += 1;
      continue;
    }
    const entry = byModel.get(model.modelId) ?? { model, ids: [] };
    byModel.set(model.modelId, entry);
    if (!entry.ids.includes(ref.expressId)) entry.ids.push(ref.expressId);
  }
  if (byModel.size === 0) return { kind: 'none', skipped };
  if (byModel.size > 1) return { kind: 'multiple-models', skipped, modelCount: byModel.size };
  const { model, ids } = [...byModel.values()][0];
  return {
    kind: 'ready',
    skipped,
    modelId: model.modelId,
    modelName: model.name,
    store: model.store,
    productIds: ids,
  };
}

/** The slice of `GeometryProcessor` the preflight drives — a test seam. */
export type LandXmlTerrainProcessor = Pick<GeometryProcessor, 'init' | 'exportLandXmlTerrain' | 'dispose'>;

/** The preflight outcome the dialog renders. */
export type TerrainPreflight =
  | { status: 'ready'; result: LandXmlTerrainExport }
  /** The producer refused the selection; `reason` is its message, verbatim. */
  | { status: 'refused'; reason: string }
  /** The geometry engine did not initialise. */
  | { status: 'unavailable' }
  | { status: 'failed'; message: string };

/**
 * Run the LandXML terrain producer over `bytes` for `productIds`, writing the
 * document as `options` say (units, precision, surface names; #7618).
 * `createProcessor` defaults to the real wasm processor; tests inject a stub.
 */
export async function runLandXmlTerrainExport(
  bytes: Uint8Array,
  productIds: readonly number[],
  createProcessor: () => LandXmlTerrainProcessor = () => new GeometryProcessor(),
  options: LandXmlTerrainExportOptions = {},
): Promise<TerrainPreflight> {
  const processor = createProcessor();
  try {
    await processor.init();
    const result = processor.exportLandXmlTerrain(bytes, Uint32Array.from(productIds), options);
    return result ? { status: 'ready', result } : { status: 'unavailable' };
  } catch (error) {
    const reason = terrainRefusalReason(error);
    if (reason !== null) return { status: 'refused', reason };
    console.error('LandXML terrain export failed:', error);
    return { status: 'failed', message: error instanceof Error ? error.message : String(error) };
  } finally {
    processor.dispose();
  }
}

/** `<model>_terrain.xml`; a legacy session (no model name) gets `model_terrain.xml`. */
export function landXmlTerrainFilename(modelName: string): string {
  return modelExportFilename(modelName, 'xml', '_terrain');
}
