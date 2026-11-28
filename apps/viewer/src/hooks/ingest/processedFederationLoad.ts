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
 * - The primary goes first and alone: it resets the viewer, and the others
 *   join the federation it starts. They also wait for its properties: a
 *   primary registers from its meshes and grows its ID range when its
 *   properties arrive, which only the newest range can do in full. A
 *   federated slot registers with its properties, so its range is final.
 * - The rest load at most `concurrency` at a time, in slot order. Each add
 *   carries its slot's position as its request time, so the RTC anchor follows
 *   slot order whatever order the loads finish in (#4897).
 * - A failed slot is listed as failed (the loader leaves its record) and the
 *   others carry on.
 * - A slot keeps its slot id as its model id: the host's identity for it.
 * - A newer primary load (the user opens a file) ends the federation: no
 *   slot that has not started yet starts.
 */

import { useViewerStore } from '@/store';
import { placementFromMatrix } from '@/lib/model-placement/matrix-placement';
import { rotationRefusal } from '@/lib/model-placement/rotation-refusal';
import type { FiledProcessedModelRequest, ProcessedFederationRequest } from '@/lib/processed-model';
import type { ProcessedFederationSlot } from '@/lib/features/runtime-config';
import type { FederationAddModelOptions } from '../modelLoadOptions.js';
import { watchLoadSupersession } from '../modelLoadCanceller.js';

/** How many non-primary slots load at once unless a caller says otherwise. */
export const DEFAULT_FEDERATION_CONCURRENCY = 2;

export interface ProcessedFederationLoaders {
  /** The primary load (`useIfcLoader.loadProcessedModel` with a primary target). */
  openPrimary: (request: FiledProcessedModelRequest, modelId: string) => Promise<void>;
  /** A federated add (`useIfcFederation.addProcessedModel`); the model id, or `null` when it did not register. */
  addSlot: (request: FiledProcessedModelRequest, options: FederationAddModelOptions) => Promise<string | null>;
  concurrency?: number;
}

export interface ProcessedFederationOutcome {
  /** Slot ids whose model registered. */
  loaded: string[];
  /** Slot ids that were tried and did not register. */
  failed: string[];
  /** Slot ids never started because a newer load replaced the federation. */
  skipped: string[];
}

const requestOf = (slot: ProcessedFederationSlot): FiledProcessedModelRequest => ({ sha256: slot.sha256, bytes: slot.bytes, name: slot.name });

/**
 * Give a registered slot the host's transform through the same placement state
 * the reposition tool and placement manifests write. Set as the model's
 * starting placement, not recorded as an undoable move: the user did not make
 * it. Returns false when the model cannot carry it (and says why).
 */
export function applySlotPlacement(modelId: string, transform: readonly number[] | undefined): boolean {
  if (!transform) return true;
  const placement = placementFromMatrix(transform);
  const state = useViewerStore.getState();
  if (!placement || !state.models.has(modelId)) return false;
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

/** The host's label and visibility on a primary, which its load target has no field for. */
function applyPrimarySlot(slot: ProcessedFederationSlot): void {
  const { models, setModelName, setModelVisibility } = useViewerStore.getState();
  const model = models.get(slot.slot);
  if (!model) return;
  if (model.name !== slot.label) setModelName(slot.slot, slot.label);
  if (!slot.visible) setModelVisibility(slot.slot, false);
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

const registered = (modelId: string) => useViewerStore.getState().models.get(modelId)?.loadState === 'complete';

export async function loadProcessedFederation(
  request: ProcessedFederationRequest,
  loaders: ProcessedFederationLoaders,
): Promise<ProcessedFederationOutcome> {
  const outcome: ProcessedFederationOutcome = { loaded: [], failed: [], skipped: [] };
  const [primary, ...rest] = request.slots;
  if (!primary) return outcome;
  await loaders.openPrimary(requestOf(primary), primary.slot);
  // Our own primary has started; from here a primary is someone else's and replaces the federation.
  const supersession = watchLoadSupersession('primary');
  try {
    // Another load that replaced ours removed our record; a failed primary leaves its record, and the rest still join.
    if (!useViewerStore.getState().models.has(primary.slot)) {
      outcome.skipped.push(...request.slots.map(slot => slot.slot));
      return outcome;
    }
    applyPrimarySlot(primary);
    if (registered(primary.slot)) { applySlotPlacement(primary.slot, primary.transform); outcome.loaded.push(primary.slot); }
    else outcome.failed.push(primary.slot);
    await propertiesSettled(primary.slot, supersession.signal);

    // Request order decides the RTC anchor, not completion order.
    const firstRequest = Date.now();
    const addOne = async (slot: ProcessedFederationSlot, index: number): Promise<void> => {
      const options: FederationAddModelOptions = {
        modelId: slot.slot, name: slot.label, visible: slot.visible, loadedAt: firstRequest + index,
        // Retry from the failed slot's card re-runs this slot only, placement included.
        retryOperation: () => { void addOne(slot, index); },
      };
      const modelId = await loaders.addSlot(requestOf(slot), options);
      if (modelId) { applySlotPlacement(modelId, slot.transform); return; }
      throw new Error(`slot ${slot.slot} did not register`);
    };
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < rest.length && !supersession.signal.aborted) {
        const index = next++;
        const slot = rest[index];
        try { await addOne(slot, index + 1); outcome.loaded.push(slot.slot); }
        catch (error) {
          if (supersession.signal.aborted) { outcome.skipped.push(slot.slot); continue; }
          console.warn('[viewer config] Federation slot failed; the other slots carry on', error);
          outcome.failed.push(slot.slot);
        }
      }
    };
    const lanes = Math.max(1, Math.min(loaders.concurrency ?? DEFAULT_FEDERATION_CONCURRENCY, rest.length));
    await Promise.all(Array.from({ length: lanes }, worker));
    outcome.skipped.push(...rest.slice(next).map(slot => slot.slot));
    return outcome;
  } finally {
    supersession.stop();
  }
}
