/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Single source of truth for "which loaded models have pending changes, and
 * how many". Both the toolbar Export Changes badge and its multi-model export
 * loop read from here, so the count the user sees and the set of files they get
 * can never disagree (issue #1534: the badge + export used to look at only the
 * first federated model).
 *
 * `collectChangedModels` is pure over a store-shaped snapshot so it stays unit
 * testable. Its per-model `changeCount` tracks the store's
 * `getModifiedEntityCount` contribution (property/quantity/attribute edits ->
 * distinct modified entities, +1 for georef edits, generated / edited schedule
 * tasks attributed to a single resolved target model), so
 * `sum(changeCount) === getModifiedEntityCount(state)` for the common states
 * (locked by a unit test). The one intentional divergence: georef edits are
 * counted even when the model also carries property edits, so a georef edit is
 * never dropped from the export set — a slight, deliberate over-count vs the
 * store in that rare both-edits case.
 */

import type { IfcDataStore, ScheduleExtraction } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { GeometryResult } from '@ifc-lite/geometry';
import type { FederatedModel, SchemaVersion } from '@/store/types';
import type { GeorefMutationData } from '@/store/slices/mutationSlice';
import type { ExportScheduleState } from '@/sdk/adapters/export-schedule-splice';
// Import from the pure helpers module (not the slice) so this stays free of the
// slice's runtime graph — keeps the module and its tests hermetic.
import { countGeneratedTasks } from '@/store/slices/schedule-edit-helpers';
import { sanitizeFilename } from './download.js';

/** Synthetic id for the legacy single-model store (no federation map). */
export const LEGACY_MODEL_ID = '__legacy__';

/**
 * The subset of the viewer store `collectChangedModels` /
 * `buildChangedArtifacts` read. Declared structurally (not as the full
 * `ViewerState`) so tests can build a minimal snapshot, and so the real store
 * — whose Maps are mutable — is assignable via `ReadonlyMap`.
 */
export interface ChangesExportState {
  /** Federated models keyed by id. Empty in legacy single-model mode. */
  models: ReadonlyMap<string, FederatedModel>;
  /** Legacy single-model data store (used only when `models` is empty). */
  ifcDataStore: IfcDataStore | null;
  /** Legacy single-model geometry (IFC5 legacy export needs it). */
  geometryResult: GeometryResult | null;
  /** Per-model overlay of pending edits. A model only has a view once edited. */
  mutationViews: ReadonlyMap<string, MutablePropertyView>;
  /** Per-model georeferencing edits. */
  georefMutations: ReadonlyMap<string, GeorefMutationData>;
  /** In-memory schedule (generated tasks / edits) pending export. */
  scheduleData: ScheduleExtraction | null;
  /** True when the parsed schedule has been edited since load. */
  scheduleIsEdited: boolean;
  /** Model the schedule is attributed to (null for untouched / unattributed). */
  scheduleSourceModelId: string | null;
}

/** One loaded model with pending, exportable changes. */
export interface ChangedModelEntry {
  /** Federated model id, or {@link LEGACY_MODEL_ID}. */
  id: string;
  /** Raw model name (may carry a file extension); sanitize at the file layer. */
  name: string;
  schemaVersion: SchemaVersion;
  /** null for native-metadata models — export layer decides exportability. */
  ifcDataStore: IfcDataStore | null;
  /** Distinct modified entities + this model's schedule contribution. */
  changeCount: number;
  /** True only for the one model the global schedule is attributed to. */
  isScheduleTarget: boolean;
}

export interface ChangedModelsResult {
  /** Only models whose `changeCount > 0`, in model insertion order. */
  models: ChangedModelEntry[];
  /** The single model the pending schedule is spliced into (null = none). */
  scheduleTargetModelId: string | null;
}

interface ResolvedModel {
  name: string;
  schemaVersion: SchemaVersion;
  ifcDataStore: IfcDataStore | null;
}

/**
 * Candidate model ids, in a stable order. Legacy and federated are mutually
 * exclusive: the legacy store is only consulted when the federation map is
 * empty, so a populated map with a lingering `ifcDataStore` never emits a
 * phantom legacy entry (mirrors the original ExportChangesButton fallback).
 */
function candidateModelIds(state: ChangesExportState): string[] {
  if (state.models.size > 0) return Array.from(state.models.keys());
  if (state.ifcDataStore) return [LEGACY_MODEL_ID];
  return [];
}

function resolveModel(state: ChangesExportState, id: string): ResolvedModel | null {
  if (id === LEGACY_MODEL_ID) {
    if (!state.ifcDataStore) return null;
    return {
      name: 'model',
      schemaVersion: state.ifcDataStore.schemaVersion as SchemaVersion,
      ifcDataStore: state.ifcDataStore,
    };
  }
  const m = state.models.get(id);
  if (!m) return null;
  return { name: m.name, schemaVersion: m.schemaVersion, ifcDataStore: m.ifcDataStore };
}

function hasGeorefFields(gm: GeorefMutationData | undefined): boolean {
  if (!gm) return false;
  const crs = gm.projectedCRS ? Object.keys(gm.projectedCRS).length : 0;
  const map = gm.mapConversion ? Object.keys(gm.mapConversion).length : 0;
  return crs > 0 || map > 0;
}

/** Number of pending schedule "changes" (matches `getModifiedEntityCount`). */
function scheduleChangeCount(state: ChangesExportState): number {
  const generated = countGeneratedTasks(state.scheduleData);
  if (generated > 0) return generated;
  // An edited-but-not-generated schedule surfaces a single +1 so the badge
  // signals "pending export" without inflating per field (store parity).
  return state.scheduleIsEdited === true ? 1 : 0;
}

/** A model the STEP schedule splice can actually write into. */
function isSpliceCapable(m: ResolvedModel | null): boolean {
  return m != null && m.schemaVersion !== 'IFC5' && m.ifcDataStore != null;
}

/**
 * Resolve the one model the pending schedule is spliced into — and ONLY a model
 * that can actually receive the splice. The schedule is spliced into STEP text
 * (`injectScheduleIntoStep`), so the target must be a loaded, non-IFC5 model
 * with a data store. Returning an unspliceable target would count the schedule
 * in the badge yet drop it from every file (a silent, falsely-reported loss).
 *
 *   - no pending schedule -> null (an untouched parsed schedule is not a change)
 *   - attributed source that is a loaded, splice-capable model -> that model
 *   - attributed source that is removed / IFC5 / native -> null (do NOT
 *     misattribute the schedule to an unrelated model; it's neither counted nor
 *     claimed as exported)
 *   - unattributed (null source) -> the first splice-capable candidate, else null
 *
 * `buildChangedArtifacts` rewrites the passed schedule state's source id to this
 * resolved target so the STEP splice gate (`scheduleSourceModelId === modelId`)
 * matches deterministically regardless of the original attribution.
 */
function resolveScheduleTarget(state: ChangesExportState, candidates: string[]): string | null {
  if (scheduleChangeCount(state) === 0) return null;

  const src = state.scheduleSourceModelId;
  if (src != null) {
    return candidates.includes(src) && isSpliceCapable(resolveModel(state, src)) ? src : null;
  }

  for (const id of candidates) {
    if (isSpliceCapable(resolveModel(state, id))) return id;
  }
  return null;
}

/**
 * Collect every loaded model with pending, exportable changes plus the resolved
 * schedule target. Pure over {@link ChangesExportState}.
 */
export function collectChangedModels(state: ChangesExportState): ChangedModelsResult {
  const candidates = candidateModelIds(state);
  const scheduleTargetModelId = resolveScheduleTarget(state, candidates);
  const scheduleCount = scheduleChangeCount(state);

  const models: ChangedModelEntry[] = [];
  for (const id of candidates) {
    const m = resolveModel(state, id);
    if (!m) continue; // stale id (model removed) — nothing to export

    const view = state.mutationViews.get(id);
    // Distinct modified entities from the overlay, plus +1 when the model has
    // georeferencing edits. Georef is counted even when a (possibly
    // inspection-only) view exists, so a georef-only edit on an already-viewed
    // model is never dropped from the export set. (getModifiedEntityCount counts
    // georef only when the model has no view — this is a deliberate, more
    // inclusive divergence in the rare property-and-georef case.)
    let changeCount = view ? view.getModifiedEntityCount() : 0;
    if (hasGeorefFields(state.georefMutations.get(id))) changeCount += 1;

    const isScheduleTarget = id === scheduleTargetModelId;
    if (isScheduleTarget) changeCount += scheduleCount;

    if (changeCount > 0) {
      models.push({
        id,
        name: m.name,
        schemaVersion: m.schemaVersion,
        ifcDataStore: m.ifcDataStore,
        changeCount,
        isScheduleTarget,
      });
    }
  }

  return { models, scheduleTargetModelId };
}

/** Total pending changes across all changed models — the badge number. */
export function totalChangeCount(result: ChangedModelsResult): number {
  let n = 0;
  for (const m of result.models) n += m.changeCount;
  return n;
}

// ────────────────────────────────────────────────────────────────────────────
// Artifact builder
//
// Turns the changed-model set into a list of per-model export artifacts (one
// `.ifc` per STEP model, one `.ifcx` per IFC5 model). Kept pure by taking the
// heavy exporters as injected `deps` — the real wiring lives in
// `changed-model-export.ts`, so this module (and its tests) never load the
// browser renderer or the store barrel. The component turns `files` into a
// single download or a zip, and reports `skipped`.
// ────────────────────────────────────────────────────────────────────────────

/** A produced export payload for one model, before final naming. */
export interface ChangesExportArtifact {
  content: string | Uint8Array;
  ext: 'ifc' | 'ifcx';
  mime: string;
}

/** STEP export request handed to the injected `exportStep` dep. */
export interface StepExportInvocation {
  schema: 'IFC2X3' | 'IFC4' | 'IFC4X3';
  georefMutations?: GeorefMutationData;
  /** Real schedule state ONLY for the schedule-target model; null otherwise. */
  scheduleState: ExportScheduleState | null;
  description: string;
}

/** IFC5 export request handed to the injected `exportIfcx` dep. */
export interface IfcxExportInvocation {
  geometryResult: GeometryResult | null;
  idOffset: number;
}

export interface BuildArtifactsDeps {
  /** Hydrate a model's exportable data store (native models may resolve null). */
  resolveStepDataStore: (modelId: string) => Promise<IfcDataStore | null>;
  exportStep: (
    modelId: string,
    dataStore: IfcDataStore,
    view: MutablePropertyView | undefined,
    invocation: StepExportInvocation,
  ) => Promise<ChangesExportArtifact>;
  exportIfcx: (
    modelId: string,
    dataStore: IfcDataStore,
    view: MutablePropertyView | undefined,
    invocation: IfcxExportInvocation,
  ) => Promise<ChangesExportArtifact>;
}

/** A produced file (base name is deduped so `base.ext` is unique in the set). */
export interface ArtifactFile {
  base: string;
  ext: 'ifc' | 'ifcx';
  mime: string;
  content: string | Uint8Array;
  modelId: string;
  changeCount: number;
}

export interface SkippedModel {
  name: string;
  reason: string;
}

export interface BuildArtifactsResult {
  files: ArtifactFile[];
  skipped: SkippedModel[];
  scheduleTargetModelId: string | null;
  /** True if the pending schedule was actually spliced into a produced STEP file. */
  scheduleSpliced: boolean;
}

/** Map any schema string to the STEP schema token (matches the legacy button). */
export function mapStepSchema(schemaVersion: string): 'IFC2X3' | 'IFC4' | 'IFC4X3' {
  return schemaVersion.includes('2X3')
    ? 'IFC2X3'
    : schemaVersion.includes('4X3')
      ? 'IFC4X3'
      : 'IFC4';
}

function stripExtension(name: string): string {
  return name.replace(/\.[^.]+$/, '');
}

/**
 * Reserve a collision-free base for `base.ext`. fflate keys zip entries by
 * name and silently clobbers duplicates, and federated models frequently share
 * a name (and `sanitizeFilename` truncates to 60 chars), so two `model.ifc`
 * inputs must become `model.ifc` + `model-2.ifc`. Same base, different ext
 * (`model.ifc` + `model.ifcx`) do NOT collide.
 */
export function uniqueArtifactBase(base: string, ext: string, used: Set<string>): string {
  if (!used.has(`${base}.${ext}`)) {
    used.add(`${base}.${ext}`);
    return base;
  }
  let i = 2;
  while (used.has(`${base}-${i}.${ext}`)) i++;
  used.add(`${base}-${i}.${ext}`);
  return `${base}-${i}`;
}

/**
 * Build every changed model's export artifact. Sequential (one `await` per
 * model) so peak memory stays bounded and a single failure can't discard its
 * siblings — each model is individually try/caught into `skipped`. The pending
 * schedule's real state reaches only the resolved target model; every other
 * model gets `null`, which makes double-injection structurally impossible.
 */
export async function buildChangedArtifacts(
  state: ChangesExportState,
  deps: BuildArtifactsDeps,
): Promise<BuildArtifactsResult> {
  const { models: changed, scheduleTargetModelId } = collectChangedModels(state);

  const realScheduleState: ExportScheduleState = {
    scheduleData: state.scheduleData ?? null,
    scheduleIsEdited: state.scheduleIsEdited === true,
    scheduleSourceModelId: state.scheduleSourceModelId ?? null,
  };

  const files: ArtifactFile[] = [];
  const skipped: SkippedModel[] = [];
  const usedNames = new Set<string>();
  let scheduleSpliced = false;

  for (const entry of changed) {
    const view = state.mutationViews.get(entry.id);
    // Rewrite the source id to the resolved target so the STEP splice gate
    // (`scheduleSourceModelId === modelId`) matches deterministically — even
    // when the original attribution was null (unattributed) or pointed at a
    // now-removed model. `resolveScheduleTarget` guarantees the target is
    // splice-capable, so this never routes the schedule to an IFC5/native file.
    const scheduleArg = entry.id === scheduleTargetModelId
      ? { ...realScheduleState, scheduleSourceModelId: entry.id }
      : null;

    try {
      let artifact: ChangesExportArtifact;

      if (entry.schemaVersion === 'IFC5') {
        const model = state.models.get(entry.id);
        const dataStore = model?.ifcDataStore ?? (entry.id === LEGACY_MODEL_ID ? state.ifcDataStore : null);
        if (!dataStore) {
          skipped.push({ name: entry.name, reason: 'No IFC data available for export' });
          continue;
        }
        const geometryResult = model?.geometryResult ?? (entry.id === LEGACY_MODEL_ID ? state.geometryResult : null);
        artifact = await deps.exportIfcx(entry.id, dataStore, view, {
          geometryResult,
          idOffset: model?.idOffset ?? 0,
        });
      } else {
        const dataStore = await deps.resolveStepDataStore(entry.id);
        if (!dataStore) {
          skipped.push({ name: entry.name, reason: 'Model data is unavailable for export' });
          continue;
        }
        artifact = await deps.exportStep(entry.id, dataStore, view, {
          schema: mapStepSchema(entry.schemaVersion),
          georefMutations: state.georefMutations.get(entry.id),
          scheduleState: scheduleArg,
          description: `Exported from ifc-lite with ${entry.changeCount} modifications`,
        });
        if (scheduleArg) scheduleSpliced = true;
      }

      const base = uniqueArtifactBase(
        sanitizeFilename(stripExtension(entry.name), { fallback: 'export' }),
        artifact.ext,
        usedNames,
      );
      files.push({
        base,
        ext: artifact.ext,
        mime: artifact.mime,
        content: artifact.content,
        modelId: entry.id,
        changeCount: entry.changeCount,
      });
    } catch (err) {
      skipped.push({ name: entry.name, reason: err instanceof Error ? err.message : 'Export failed' });
    }
  }

  return { files, skipped, scheduleTargetModelId, scheduleSpliced };
}
