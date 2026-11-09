/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Detect elements" on a loaded scan (#6894): gather the scan's retained
 * sample (or its section-box crop), frame it in the workspace world, run
 * the detector off the main thread and put the result in the store for
 * review. One detector for the session: a second click supersedes the first
 * run, Cancel terminates it.
 *
 * The job is a store run slot (`lib/runs/run-slot.ts`, the pilot for it): the
 * slice's `scanDetectionJob` record is the ownership. A newer start, Cancel
 * (here or in the activity tray) and the slice teardown (the scan or its
 * target removed, every model cleared, a session reset) each end the lease,
 * which terminates the worker; the lease then refuses the answer.
 */

import type { ProposalSchema } from '@ifc-lite/geometry/scan-proposals';
import { useViewerStore, type ViewerState } from '@/store';
import type { FederatedModel } from '@/store/types';
import type { ScanDetectionJob, ScanDetectionOwner, ScanDetectionRun } from '@/store/slices/scanDetectionSlice';
import type { ScanDetectStage } from './detect-job';
import type { TranslationKey } from '@/i18n';
import { createRunSlot } from '@/lib/runs/run-slot';
import { federationIsCurrent, recordGatheredModel } from '@/lib/federation/federation-identity';
import { getPointCloudScanSample } from '@/hooks/ingest/pointCloudScanCache';
import { activeSectionPlane } from '@/store/section-active';
import { getGlobalRenderer } from '@/hooks/useBCF';
import { scanToModelMatrix, sectionBoxToScanRegion } from './scan-model-frame';
import { createScanDetector, type ScanDetector } from './scan-detector';
import { assertNever } from '@/lib/assert-never';

export interface DetectionDeps {
  detector: () => ScanDetector;
  /** The renderer's column-major sample -> render matrix for a point cloud handle, float64. */
  cloudMatrix: (handleId: number) => ArrayLike<number> | null | undefined;
}

let sessionDetector: ScanDetector | null = null;

/** Refusals a detection fails with by code rather than a detector message. */
export const SCAN_DETECTION_REFUSALS: Readonly<Record<string, TranslationKey>> = {
  noSample: 'scanToBim.error.noSample',
};

const detectionSlot = createRunSlot<ScanDetectionRun, ScanDetectStage, ScanDetectionOwner, string>(
  {
    read: () => useViewerStore.getState().scanDetectionJob,
    write: (job: ScanDetectionJob) => useViewerStore.getState().setScanDetectionJob(job),
    subscribe: (listener) => useViewerStore.subscribe(listener),
  },
  {
    begin: ({ sourceModelId }) => ({
      kind: 'check', title: 'activityTray.job.scanDetection', panel: 'pointclouds',
      subject: useViewerStore.getState().models.get(sourceModelId)?.name,
    }),
    phase: (stage) => stage,
    detail: (error) => Object.hasOwn(SCAN_DETECTION_REFUSALS, error) ? { detailKey: SCAN_DETECTION_REFUSALS[error] } : { detail: error },
  },
);

const productionDeps: DetectionDeps = {
  detector: () => (sessionDetector ??= createScanDetector()),
  // The exact float64 placement: the float32 GPU transform rounds a map-grid
  // translation by centimetres (LV95 steps 0.25 m, UTM northings 0.5 m), which
  // would offset proposals and the overlay from the scan the renderer draws.
  cloudMatrix: (handleId) => getGlobalRenderer()?.getPointCloudPlacement({ id: handleId }),
};

/** Models with a streamed scan whose sample the detector can read. */
export function scanModels(models: ViewerState['models']): FederatedModel[] {
  return [...models.values()].filter((m) => typeof m.pointCloudHandleId === 'number');
}

function isIfcModel(model: FederatedModel): boolean {
  const schema = model.ifcDataStore?.schemaVersion;
  return typeof model.pointCloudHandleId !== 'number' && typeof schema === 'string' && schema.startsWith('IFC') && schema !== 'IFC5';
}

/** The IFC model proposals are framed for: the active one when it is IFC, else the first IFC model. */
export function proposalTargetModel(models: ViewerState['models'], activeModelId: string | null): FederatedModel | null {
  const active = activeModelId ? models.get(activeModelId) : undefined;
  if (active && isIfcModel(active)) return active;
  return [...models.values()].find(isIfcModel) ?? null;
}

export function proposalSchema(target: FederatedModel | null): ProposalSchema {
  const schema = target?.ifcDataStore?.schemaVersion;
  return schema === 'IFC2X3' || schema === 'IFC4X3' ? schema : 'IFC4';
}

/** Run detection on `sourceModelId`'s scan. Resolves once the store holds the outcome. */
export async function startScanDetection(sourceModelId: string, overrides: Partial<DetectionDeps> = {}): Promise<void> {
  const deps: DetectionDeps = { ...productionDeps, ...overrides };
  const state = useViewerStore.getState();
  const source = state.models.get(sourceModelId);
  const target = proposalTargetModel(state.models, state.activeModelId);
  const owner: ScanDetectionOwner = { sourceModelId, targetModelId: target?.id ?? null };
  // The models the proposals are made from and framed for. Removing either
  // already ends the job (slice teardown); a model replaced under the same id
  // (a re-derived store) is a different world too, so the result is dropped.
  const identity = new Map<string, unknown>();
  for (const id of [owner.sourceModelId, owner.targetModelId]) {
    const model = id === null ? undefined : state.models.get(id);
    if (id !== null && model) recordGatheredModel(identity, id, model);
  }
  const lease = detectionSlot.begin(owner, { scopeIsCurrent: () => federationIsCurrent(identity, useViewerStore.getState().models) });
  const handle = source?.pointCloudHandleId;
  const sample = typeof handle === 'number' ? getPointCloudScanSample(handle) : null;
  if (typeof handle !== 'number' || !sample || sample.count === 0) {
    lease.fail('noSample');
    return;
  }
  const matrix = deps.cloudMatrix(handle) ?? null;
  // The section box crops the sample when it is on screen (render frame, like
  // the cloud); a cut hidden by the visibility toggle does not crop.
  const box = activeSectionPlane(state)?.box ?? null;
  const scanToModel = scanToModelMatrix(state, matrix);
  const region = box ? sectionBoxToScanRegion(box, matrix) : null;
  const detector = deps.detector();
  // Superseded, cancelled or torn down: stop the worker. A newer run's begin
  // fires this before its own detect, so it never stops the newer job.
  lease.signal.addEventListener('abort', () => detector.cancel(), { once: true });
  let outcome: Awaited<ReturnType<ScanDetector['detect']>>;
  try {
    outcome = await detector.detect(
      { positions: sample.positions, count: sample.count, region, scanToModel, schema: proposalSchema(target) },
      (stage) => { lease.progress(stage); },
    );
  } catch (error) {
    lease.fail(error instanceof Error ? error.message : String(error));
    return;
  }
  // Each lease call is a no-op once the run is no longer this one's.
  switch (outcome.status) {
    case 'done':
      lease.succeed({
        sourceModelId,
        targetModelId: owner.targetModelId,
        cropped: region !== null,
        pointCount: sample.count,
        cloudMatrix: matrix ? Array.from(matrix) : null,
        scanToModel,
        result: outcome.result,
      });
      break;
    case 'failed': lease.fail(outcome.message); break;
    case 'cancelled': lease.cancel(); break;
    // A newer detect owns the worker, and with it the slot.
    case 'superseded': break;
    default: assertNever(outcome, 'scan detection outcome');
  }
}

/**
 * Tolerances for comparing two `scanToModel` frames. Both are computed by the
 * same code from the same inputs, so an unmoved scan reproduces the matrix
 * exactly; the bounds only absorb float64 round-off.
 * - Translation (row-major indices 3, 7, 11): absolute, in metres. It holds
 *   georeferenced coordinates (LV95 ~2.6e6 m, UTM northings ~5e6 m), so a
 *   relative bound would grow with them and miss real moves: 1e-6 relative
 *   is 2.6 m in LV95. 1e-4 m (0.1 mm) is far above round-off at 1e7 m
 *   (~2e-9 m) and far below anything a scan placement changes by.
 * - Linear part (rotation times uniform scale, entries of order 1):
 *   absolute 1e-9, i.e. a turn of about 1e-9 rad, 5e-8 m over 50 m.
 */
const FRAME_TRANSLATION_TOLERANCE_METRES = 1e-4;
const FRAME_LINEAR_TOLERANCE = 1e-9;
const TRANSLATION_ENTRIES = new Set([3, 7, 11]);

/**
 * Whether `run`'s proposals are stale: the scan's placement or alignment, or
 * the workspace anchor's offset, changed since detection, so the frame the
 * proposals were made in is no longer the scan's. Unknown (the scan is gone)
 * counts as moved.
 */
export function scanFrameMoved(run: ScanDetectionRun, overrides: Partial<DetectionDeps> = {}): boolean {
  const deps: DetectionDeps = { ...productionDeps, ...overrides };
  const state = useViewerStore.getState();
  const handle = state.models.get(run.sourceModelId)?.pointCloudHandleId;
  if (typeof handle !== 'number') return true;
  const now = scanToModelMatrix(state, deps.cloudMatrix(handle) ?? null);
  return now.some((v, i) => !(Math.abs(v - run.scanToModel[i]) <= (TRANSLATION_ENTRIES.has(i) ? FRAME_TRANSLATION_TOLERANCE_METRES : FRAME_LINEAR_TOLERANCE)));
}

/** Cancel the detection in flight; its lease terminates the worker. */
export function cancelScanDetection(): void {
  detectionSlot.cancel();
}
