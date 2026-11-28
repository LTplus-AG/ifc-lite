/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Opens a federation of processed models (`open.federation` in the runtime
 * configuration) through the one load path: the first slot as the primary
 * model, every other slot as a federated add (`useIfcFederation`), each by its
 * hash. No second pipeline: this only orders the loads and applies what the
 * host said about each slot.
 *
 * - One run at a time. A run is ended the moment a newer federation or any
 *   other primary load starts, also while its own primary is still loading;
 *   every step checks before touching the scene, so an ended run adds nothing.
 * - The primary goes first and alone: it resets the viewer, and the others
 *   join the federation it starts. They also wait until its properties have
 *   arrived or failed: a primary registers from its meshes and grows its ID
 *   range when its properties arrive, which only the newest range can do in
 *   full. If they fail, the primary is listed as failed (with Retry) and the
 *   slots still load; its meshless entities above its meshed ids plus the
 *   overlay headroom then cannot be resolved.
 * - The rest load at most `concurrency` at a time, in slot order. Each add
 *   carries its slot's position as its request time, so the RTC anchor follows
 *   slot order whatever order the loads finish in (#4897).
 * - A failed slot keeps its record (the loader leaves it) and gets its own
 *   Retry on its model row (`federation-slot-status.ts`). Retrying a slot loads
 *   that slot; retrying the primary runs the whole federation again, because a
 *   primary load replaces the scene.
 * - A slot keeps its slot id as its model id: the host's identity for it.
 */

import { useViewerStore } from '@/store';
import { resolve as translate } from '@/i18n/registry';
import { renderFrameWorldOffset } from '@ifc-lite/geometry/world-frame';
import { yawTransform } from '@/lib/model-placement/matrix-placement';
import { rotationRefusal } from '@/lib/model-placement/rotation-refusal';
import { ZERO_ROTATION } from '@/lib/model-placement/rotation';
import type { ModelPlacement } from '@/lib/model-placement/state';
import { clearFederationSlotFailures, setFederationSlotFailure } from '@/lib/federation-slot-status';
import type { FiledProcessedModelRequest, ProcessedFederationRequest } from '@/lib/processed-model';
import type { ProcessedFederationSlot } from '@/lib/features/runtime-config';
import type { FederationAddModelOptions, ModelLoadOptions } from '../modelLoadOptions.js';
import { watchLoadSupersession } from '../modelLoadCanceller.js';

/** How many non-primary slots load at once unless a caller says otherwise. */
export const DEFAULT_FEDERATION_CONCURRENCY = 2;

export interface ProcessedFederationLoaders {
  /** The primary load (`useIfcLoader.loadProcessedModel` with a primary target). Must install its canceller before its first await, as `loadModel` does. */
  openPrimary: (request: FiledProcessedModelRequest, modelId: string, options: Pick<ModelLoadOptions, 'retryOperation'>) => Promise<void>;
  /** A federated add (`useIfcFederation.addProcessedModel`); the model id, or `null` when it did not register. */
  addSlot: (request: FiledProcessedModelRequest, options: FederationAddModelOptions) => Promise<string | null>;
  concurrency?: number;
}

export interface ProcessedFederationOutcome {
  /** Slot ids whose model registered. */
  loaded: string[];
  /** Slot ids that were tried and did not register (or, for the primary, lost its properties). */
  failed: string[];
  /** Slot ids never started because a newer load replaced the federation. */
  skipped: string[];
}

const requestOf = (slot: ProcessedFederationSlot): FiledProcessedModelRequest => ({ sha256: slot.sha256, bytes: slot.bytes, name: slot.name });

/**
 * The placement a slot transform asks for, in the workspace frame placements
 * use. The transform acts on the model's IFC world coordinates; the workspace
 * is the render frame (IFC world minus `renderFrameWorldOffset`). Turning a
 * point about the IFC origin and then moving it by `t` is, in workspace terms,
 * a turn about the IFC origin's workspace image followed by the same `t`.
 */
export function slotPlacement(transform: readonly number[], frame: Parameters<typeof renderFrameWorldOffset>[0]): Omit<ModelPlacement, 'locked'> | null {
  const parts = yawTransform(transform);
  if (!parts) return null;
  const offset = renderFrameWorldOffset(frame);
  const pivot = [0 - offset.x, 0 - offset.y, 0 - offset.z] as const;
  return { translation: [...parts.translation], rotation: parts.angle === 0 ? ZERO_ROTATION : { angle: parts.angle, pivot } };
}

/**
 * Give a registered slot the host's transform through the same placement state
 * the reposition tool and placement manifests write. Set as the model's
 * starting placement, not recorded as an undoable move: the user did not make
 * it. Returns false when the model cannot carry it (and says why).
 */
export function applySlotPlacement(modelId: string, transform: readonly number[] | undefined): boolean {
  if (!transform) return true;
  const state = useViewerStore.getState();
  const model = state.models.get(modelId);
  const placement = model?.geometryResult ? slotPlacement(transform, model.geometryResult.coordinateInfo) : null;
  if (!placement) return false;
  const refusal = placement.rotation.angle !== 0 ? rotationRefusal(state, [modelId]) : null;
  if (refusal) {
    console.warn(`[viewer config] Federation slot ${modelId} keeps its own placement: ${refusal}`);
    return false;
  }
  const placements = new Map(state.modelPlacement.placements);
  placements.set(modelId, { ...placement, locked: state.modelPlacement.placements.get(modelId)?.locked ?? false });
  useViewerStore.setState({ modelPlacement: { ...state.modelPlacement, placements, revision: state.modelPlacement.revision + 1 } });
  return true;
}

/** Resolves once the model's server properties run is no longer running, or `signal` aborts. */
function propertiesSettled(modelId: string, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const check = () => {
      if (!signal.aborted && useViewerStore.getState().serverPropertiesRuns.get(modelId)?.kind === 'running') return;
      stop(); signal.removeEventListener('abort', check); resolve();
    };
    const stop = useViewerStore.subscribe(check);
    signal.addEventListener('abort', check, { once: true });
    check();
  });
}

/** The run that may still touch the scene; a newer run ends it. */
let currentRun: AbortController | null = null;

export async function loadProcessedFederation(
  request: ProcessedFederationRequest,
  loaders: ProcessedFederationLoaders,
): Promise<ProcessedFederationOutcome> {
  currentRun?.abort();
  const run = new AbortController();
  currentRun = run;
  clearFederationSlotFailures();
  const outcome: ProcessedFederationOutcome = { loaded: [], failed: [], skipped: [] };
  const [primary, ...rest] = request.slots;
  if (!primary) return outcome;
  const again = () => { void loadProcessedFederation(request, loaders).catch((error: unknown) => console.error('[viewer config] Federation retry failed', error)); };
  // `openPrimary` installs our primary's canceller before it first awaits, so a watch taken right
  // after it is ended only by a LATER primary (a newer federation, a file the user opens), never ours.
  const primaryLoad = loaders.openPrimary(requestOf(primary), primary.slot, { retryOperation: again });
  const supersession = watchLoadSupersession('primary');
  // After our primary: a slot Retry long after this run may only add to the scene this run built.
  const ours = () => useViewerStore.getState().models.get(primary.slot)?.processedModel?.sha256 === primary.sha256;
  const ended = () => run.signal.aborted || supersession.signal.aborted || !ours();
  const endedEarly = new AbortController();
  for (const signal of [run.signal, supersession.signal]) signal.addEventListener('abort', () => endedEarly.abort(), { once: true });
  const total = request.slots.length;
  let settled = 0;
  const progress = () => {
    if (!ended()) useViewerStore.getState().setProgress({ phase: `Opening ${settled} of ${total} models`, percent: Math.round((settled / total) * 100) });
  };
  try {
    await primaryLoad;
    // `ours`: our record, not one a newer load put under the same slot id.
    if (ended()) { outcome.skipped.push(...request.slots.map(slot => slot.slot)); return outcome; }
    const { setModelName, setModelVisibility } = useViewerStore.getState();
    setModelName(primary.slot, primary.label);
    if (!primary.visible) setModelVisibility(primary.slot, false);
    await propertiesSettled(primary.slot, endedEarly.signal);
    if (ended()) { outcome.skipped.push(...request.slots.map(slot => slot.slot)); return outcome; }
    const record = useViewerStore.getState().models.get(primary.slot);
    if (record?.loadState === 'complete' && record.ifcDataStore) {
      applySlotPlacement(primary.slot, primary.transform);
      outcome.loaded.push(primary.slot);
    } else {
      // No geometry (its card says why), or geometry without properties: its row offers the federation again.
      const reason = record?.loadState === 'error' ? record.loadError ?? '' : translate('viewportLighting.container.processedModel.noProperties');
      if (record?.loadState !== 'error') {
        useViewerStore.getState().updateModel(primary.slot, { loadError: reason });
        applySlotPlacement(primary.slot, primary.transform);
      }
      setFederationSlotFailure(primary.slot, { reason, retry: again });
      outcome.failed.push(primary.slot);
    }
    settled = 1; progress();

    // Request order decides the RTC anchor, not completion order.
    const firstRequest = Date.now();
    const addOne = async (slot: ProcessedFederationSlot, index: number): Promise<boolean> => {
      if (ended()) return false;
      setFederationSlotFailure(slot.slot, null);
      const options: FederationAddModelOptions = {
        modelId: slot.slot, name: slot.label, visible: slot.visible, loadedAt: firstRequest + index,
        // The card's Retry and the row's Retry both load this slot again, placement included, and never reject.
        retryOperation: () => { void addOne(slot, index); },
      };
      let modelId: string | null = null;
      try { modelId = await loaders.addSlot(requestOf(slot), options); }
      catch (error) { console.warn(`[viewer config] Federation slot ${slot.slot} failed`, error); }
      if (ended()) return false;
      if (modelId) { applySlotPlacement(modelId, slot.transform); return true; }
      const reason = useViewerStore.getState().models.get(slot.slot)?.loadError ?? '';
      setFederationSlotFailure(slot.slot, { reason, retry: options.retryOperation! });
      return false;
    };
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < rest.length && !ended()) {
        const index = next++;
        const slot = rest[index];
        const ok = await addOne(slot, index + 1);
        if (ended()) { outcome.skipped.push(slot.slot); continue; }
        (ok ? outcome.loaded : outcome.failed).push(slot.slot);
        settled++; progress();
      }
    };
    const wanted = loaders.concurrency ?? DEFAULT_FEDERATION_CONCURRENCY;
    const cap = Number.isFinite(wanted) && wanted >= 1 ? Math.floor(wanted) : DEFAULT_FEDERATION_CONCURRENCY;
    await Promise.all(Array.from({ length: Math.min(cap, rest.length) }, worker));
    outcome.skipped.push(...rest.slice(next).map(slot => slot.slot));
    return outcome;
  } finally {
    // The run stays `currentRun`: a newer federation still ends its slot retries.
    supersession.stop();
  }
}
