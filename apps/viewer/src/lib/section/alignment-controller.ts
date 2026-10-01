/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { create } from 'zustand';
import { contiguousSourceBytes } from '@ifc-lite/parser';
import { nearestCardinalAxis } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { resolveExportModel } from '@/components/viewer/export-model-selection';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { getWholeSourceForWorker } from '@/lib/overlay-parse/source-handoff';
import { displayedTranslation, placementFor } from '@/lib/model-placement/state';
import { AlignmentClient } from './alignment-client';
import { placementCoordinateInfo } from './placement-coordinate-info';
import { mergedSectionBounds, sectionAxisRange, worldToPercent } from './section-distance';
import { customPlaneCenter } from '@/store/slices/section-plane-center';
import { alignmentSectionPlane } from './alignment-plane';
import type { AlignmentAxisMetadata, AlignmentSectionBinding, AlignmentSectionSample } from './alignment-contract';

interface AlignmentToolState {
  choosing: boolean;
  busy: boolean;
  metadata?: AlignmentAxisMetadata;
  error?: string;
}
/** Ephemeral UI only; the geometric binding lives on the canonical cut. */
export const useAlignmentToolState = create<AlignmentToolState>(() => ({ choosing: false, busy: false }));

let client: AlignmentClient | undefined;
let generation = 0;
let request = 0;
let queuedDistance: number | undefined;
let lastSample: AlignmentSectionSample | undefined;
let owner: { modelId: string; expressId: number; store: unknown; mutationVersion: number; distance: number } | undefined;
let unsubscribe: (() => void) | undefined;

function modelFor(id: string) {
  const state = useViewerStore.getState();
  return resolveExportModel(state.models, id, state.ifcDataStore, state.geometryResult);
}

function apply(sample: AlignmentSectionSample, binding: AlignmentSectionBinding, initial: boolean): void {
  const model = modelFor(binding.modelId);
  if (!model?.ifcDataStore) throw new Error('Alignment owner was removed');
  const state = useViewerStore.getState();
  const custom = alignmentSectionPlane(sample, model.geometryResult?.coordinateInfo,
    displayedTranslation(state.modelPlacement, binding.modelId), binding, placementFor(state.modelPlacement, binding.modelId).rotation);
  const cardinal = nearestCardinalAxis(custom.normal);
  const merged = mergedSectionBounds(state.models, state.geometryResult);
  const source = model.geometryResult?.coordinateInfo;
  const placed = placementCoordinateInfo(source && merged ? { ...source, shiftedBounds: merged } : source, state.models, state.modelPlacement);
  const range = sectionAxisRange(placed?.shiftedBounds ?? merged, cardinal.axis);
  const center = customPlaneCenter(custom);
  const component = cardinal.axis === 'side' ? center[0] : cardinal.axis === 'down' ? center[1] : center[2];
  const position = range ? worldToPercent(component, range) : state.sectionPlane.position;
  useViewerStore.setState({ sectionPlane: { ...state.sectionPlane, custom, box: undefined,
    axis: cardinal.axis, position, ...(initial ? { enabled: true } : {}) }, sectionPickMode: false, sectionPickPreview: null });
  if (initial) state.setSectionVisible(true);
  lastSample = sample;
}

export function closeAlignmentEvaluator(): void {
  ++generation; ++request; queuedDistance = undefined;
  client?.close(); client = undefined; owner = undefined; lastSample = undefined;
  useAlignmentToolState.setState({ busy: false, metadata: undefined });
}

export function chooseAlignmentMode(): void {
  closeAlignmentEvaluator();
  const state = useViewerStore.getState();
  state.setSectionPickMode(false);
  const custom = state.sectionPlane.custom;
  if (custom?.alignment) useViewerStore.setState({ sectionPlane: {
    ...state.sectionPlane, custom: { ...custom, alignment: undefined } } });
  useAlignmentToolState.setState({ choosing: true, error: undefined });
}

export function leaveAlignmentMode(): void {
  closeAlignmentEvaluator();
  useAlignmentToolState.setState({ choosing: false, error: undefined });
}

function fail(error: unknown): void {
  closeAlignmentEvaluator();
  const state = useViewerStore.getState();
  const custom = state.sectionPlane.custom;
  if (custom?.alignment) {
    useViewerStore.setState({ sectionPlane: { ...state.sectionPlane,
      custom: { ...custom, alignment: undefined }, enabled: false } });
  }
  useAlignmentToolState.setState({ choosing: true,
    error: error instanceof Error ? error.message : String(error) });
}

export async function bindAlignment(modelId: string, expressId: number, distance = 0): Promise<void> {
  const previousBinding = useViewerStore.getState().sectionPlane.custom?.alignment;
  const initial = previousBinding?.modelId !== modelId || previousBinding.expressId !== expressId;
  closeAlignmentEvaluator();
  const version = generation;
  useAlignmentToolState.setState({ choosing: true, busy: true, error: undefined });
  try {
    const model = modelFor(modelId);
    if (!model?.ifcDataStore || model.schemaVersion === 'IFC5' || model.sourceSchema) {
      throw new Error('A STEP IFC alignment model is required');
    }
    if (!model.geometryResult || ('loadState' in model && model.loadState && model.loadState !== 'complete' && model.loadState !== 'error')) {
      throw new Error('Wait for alignment model geometry to finish loading');
    }
    const state = useViewerStore.getState();
    const view = state.getMutationView(modelId);
    // Retain the compressed source envelope when untouched: inflation and
    // UTF-8 decoding belong in the disposable worker, never the render thread.
    const source = view?.hasPendingChanges()
      ? contiguousSourceBytes(editedModelBytes(model.ifcDataStore, view)).toTransferable()
      : getWholeSourceForWorker(model.ifcDataStore);
    owner = { modelId, expressId, store: model.ifcDataStore, mutationVersion: state.mutationVersion, distance };
    client = new AlignmentClient();
    const opened = await client.request({ kind: 'open', source, expressId });
    if (version !== generation) return;
    let target = queuedDistance ?? distance; queuedDistance = undefined;
    let evaluated = target === 0 ? opened : await client.request({ kind: 'evaluate', distance: target });
    if (version !== generation) return;
    // Reopening after a source edit is not yet ready for station RPCs. Keep
    // only the latest intent, and evaluate it once the retained axis is open.
    while (queuedDistance !== undefined) {
      target = queuedDistance; queuedDistance = undefined;
      evaluated = await client.request({ kind: 'evaluate', distance: target });
      if (version !== generation) return;
    }
    useAlignmentToolState.setState({ metadata: opened.metadata, choosing: false, busy: false });
    apply(evaluated.sample, { modelId, expressId,
      geometricHorizontalDistanceMeters: evaluated.sample.geometricHorizontalDistanceMeters,
      geometricHorizontalLengthMeters: opened.metadata.geometricHorizontalLengthMeters }, initial);
  } catch (error) { if (version === generation) fail(error); }
}

export async function setAlignmentDistance(distance: number): Promise<void> {
  const binding = useViewerStore.getState().sectionPlane.custom?.alignment;
  if (!client || !binding || !owner || owner.modelId !== binding.modelId || owner.expressId !== binding.expressId
    || !Number.isFinite(distance)) return;
  if (useAlignmentToolState.getState().busy) { queuedDistance = distance; return; }
  const version = generation;
  const sequence = ++request;
  try {
    const result = await client.request({ kind: 'evaluate', distance });
    if (version !== generation || sequence !== request
      || !useViewerStore.getState().sectionPlane.custom?.alignment) return;
    apply(result.sample, { ...binding, geometricHorizontalDistanceMeters: distance }, false);
  } catch (error) { if (version === generation && sequence === request) fail(error); }
}

/** Scene component owns this lifetime, including model removal and edits. */
export function startAlignmentTool(): () => void {
  unsubscribe?.();
  unsubscribe = useViewerStore.subscribe((state, previous) => {
    const binding = state.sectionPlane.custom?.alignment;
    if (!binding || state.sectionPickMode) {
      if (owner && useAlignmentToolState.getState().busy && !state.sectionPickMode) {
        const opening = modelFor(owner.modelId);
        if (!opening?.ifcDataStore) fail(new Error('Alignment owner was removed'));
        else if (opening.ifcDataStore !== owner.store || owner.mutationVersion !== state.mutationVersion) {
          void bindAlignment(owner.modelId, owner.expressId, owner.distance);
        }
      } else if (owner) leaveAlignmentMode();
      return;
    }
    const model = modelFor(binding.modelId);
    if (!model?.ifcDataStore) { fail(new Error('Alignment owner was removed')); return; }
    if (!owner || owner.modelId !== binding.modelId || owner.expressId !== binding.expressId
      || owner.store !== model.ifcDataStore || owner.mutationVersion !== state.mutationVersion) {
      void bindAlignment(binding.modelId, binding.expressId, binding.geometricHorizontalDistanceMeters);
    } else if (lastSample && (state.modelPlacement !== previous.modelPlacement
      || state.models !== previous.models || state.geometryResult !== previous.geometryResult)) {
      apply(lastSample, binding, false);
    }
  });
  const binding = useViewerStore.getState().sectionPlane.custom?.alignment;
  if (binding) void bindAlignment(binding.modelId, binding.expressId, binding.geometricHorizontalDistanceMeters);
  return () => {
    unsubscribe?.(); unsubscribe = undefined;
    // A parked cut remains in workspace coordinates. Do not retain a claimed
    // model binding after its ownership listener/evaluator lifetime ends.
    chooseAlignmentMode(); leaveAlignmentMode();
  };
}
