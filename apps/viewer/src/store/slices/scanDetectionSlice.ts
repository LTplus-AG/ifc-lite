/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Scan-to-BIM review state (#6894): the latest detection run on a scan, the
 * per-proposal accept / reject decisions and the review list's filter. The
 * run itself is started by `lib/scan-to-bim/run-detection.ts`; nothing here
 * talks to the worker or the renderer.
 */

import type { StateCreator } from 'zustand';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { ProposalClass } from '@ifc-lite/geometry/scan-proposals';
import type { ScanDetectResult, ScanDetectStage } from '@/lib/scan-to-bim/detect-job';
import { IDLE_RUN, type Run } from '@/lib/runs/run';
import { defineSliceTeardown } from '../teardown.js';
import type { FederatedModel } from '../types';

export type ScanProposalDecision = 'accepted' | 'rejected';

export const SCAN_PROPOSAL_CLASSES: readonly ProposalClass[] = ['IfcWall', 'IfcSlab', 'IfcColumn', 'IfcPipeSegment', 'IfcFlowSegment'];

export interface ScanDetectionRun {
  /** The scan model the sample came from. */
  sourceModelId: string;
  /** The IFC model the proposals are framed for, or null (workspace world). */
  targetModelId: string | null;
  /** The sample was cropped to the section box. */
  cropped: boolean;
  /** Sample points the run read. */
  pointCount: number;
  /** Column-major sample -> render matrix at detection time, for the overlay. */
  cloudMatrix: number[] | null;
  /**
   * Row-major sample -> workspace world the proposals were made through
   * (`scanToModelMatrix`). Creation refuses once the current one differs: the
   * scan or the workspace anchor moved, and the proposals no longer sit on it.
   */
  scanToModel: number[];
  result: ScanDetectResult;
}

/** What a detection run reads: it ends when either model leaves. */
export interface ScanDetectionOwner {
  sourceModelId: string;
  targetModelId: string | null;
}

/**
 * The detection job (`lib/runs/run-slot.ts`). A failure carries a refusal code
 * (`noSample`) or the detector's message. A success also becomes
 * `scanDetectionRun`, which outlives later cancelled or failed jobs.
 */
export type ScanDetectionJob = Run<ScanDetectionRun, ScanDetectStage, ScanDetectionOwner, string>;

export interface ScanProposalFilter {
  classes: readonly ProposalClass[];
  /** 0..1 */
  minConfidence: number;
}

export interface ScanDetectionSlice {
  /** The detection job in flight or last ended; written only through its run slot. */
  scanDetectionJob: ScanDetectionJob;
  /** The last successful run: what the review list and overlay show. */
  scanDetectionRun: ScanDetectionRun | null;
  scanProposalDecisions: Readonly<Record<string, ScanProposalDecision>>;
  scanProposalFilter: ScanProposalFilter;
  /** Proposals created as IFC elements in this run, by proposal id. */
  scanProposalCreated: Readonly<Record<string, ScanCreatedRecord>>;
  /**
   * GlobalIds of every element created from each scan this session, by scan
   * model id. Unlike `scanProposalCreated` it survives "Detect again", so the
   * create bar can warn before a new run's proposals duplicate them.
   */
  scanCreatedGlobalIds: Readonly<Record<string, readonly string[]>>;
  /**
   * The run slot's store binding (`lib/scan-to-bim/run-detection.ts`); start,
   * cancel and finish a detection there. A success also replaces the reviewed
   * run and its decisions; a cancel or failure keeps the previous run reviewable.
   */
  setScanDetectionJob: (job: ScanDetectionJob) => void;
  /** null clears a decision back to pending. */
  decideScanProposals: (ids: readonly string[], decision: ScanProposalDecision | null) => void;
  setScanProposalFilter: (patch: Partial<ScanProposalFilter>) => void;
  clearScanDetection: () => void;
  recordScanProposalsCreated: (modelId: string, items: ReadonlyArray<{ proposalId: string; expressId: number; globalId: string }>) => void;
}

export interface ScanCreatedRecord {
  modelId: string;
  expressId: number;
  /** The element's GlobalId: it survives export and reopening, express ids do not. */
  globalId: string;
}

const DEFAULT_FILTER: ScanProposalFilter = { classes: SCAN_PROPOSAL_CLASSES, minConfidence: 0 };

export const createScanDetectionSlice: StateCreator<ScanDetectionSlice, [], [], ScanDetectionSlice> = (set) => ({
  scanDetectionJob: IDLE_RUN,
  scanDetectionRun: null,
  scanProposalDecisions: {},
  scanProposalFilter: DEFAULT_FILTER,
  scanProposalCreated: {},
  scanCreatedGlobalIds: {},
  setScanDetectionJob: (job) => set(job.kind === 'succeeded'
    ? { scanDetectionJob: job, scanDetectionRun: job.result, scanProposalDecisions: {}, scanProposalCreated: {} }
    : { scanDetectionJob: job }),
  decideScanProposals: (ids, decision) => set((s) => {
    const next = { ...s.scanProposalDecisions };
    for (const id of ids) {
      if (decision) next[id] = decision;
      else delete next[id];
    }
    return { scanProposalDecisions: next };
  }),
  setScanProposalFilter: (patch) => set((s) => {
    const minConfidence = patch.minConfidence ?? s.scanProposalFilter.minConfidence;
    return {
      scanProposalFilter: {
        classes: patch.classes ?? s.scanProposalFilter.classes,
        minConfidence: Number.isFinite(minConfidence) ? Math.min(1, Math.max(0, minConfidence)) : 0,
      },
    };
  }),
  clearScanDetection: () => set((s) => ({
    // Clearing the review keeps a job in flight: it is the run slot's to end.
    ...(s.scanDetectionJob.kind === 'running' ? {} : { scanDetectionJob: IDLE_RUN }),
    scanDetectionRun: null, scanProposalDecisions: {}, scanProposalCreated: {},
  })),
  recordScanProposalsCreated: (modelId, items) => set((s) => {
    const next = { ...s.scanProposalCreated };
    for (const { proposalId, expressId, globalId } of items) next[proposalId] = { modelId, expressId, globalId };
    const source = s.scanDetectionRun?.sourceModelId;
    if (!source) return { scanProposalCreated: next };
    const history = [...(s.scanCreatedGlobalIds[source] ?? []), ...items.map((i) => i.globalId)];
    return { scanProposalCreated: next, scanCreatedGlobalIds: { ...s.scanCreatedGlobalIds, [source]: history } };
  }),
});

/** The reviewed run and its decisions; the job is ended separately (`jobEnds`). */
const cleared = () => ({
  scanDetectionRun: null,
  scanProposalDecisions: {},
  scanProposalCreated: {},
});

export const scanDetectionTeardown = defineSliceTeardown(
  'scanDetectionSlice',
  ['scanDetectionJob', 'scanDetectionRun', 'scanProposalDecisions', 'scanProposalFilter', 'scanProposalCreated', 'scanCreatedGlobalIds'],
  {
    // Writing the job idle INVALIDATES a run in flight: its lease aborts the
    // worker and can no longer publish into the new session.
    'session-reset': () => ({ ...cleared(), scanDetectionJob: IDLE_RUN, scanProposalFilter: DEFAULT_FILTER, scanCreatedGlobalIds: {} }),
    // A run, in flight or reviewed, belongs to its scan and its target model: either leaving ends it.
    'model-removed': (scope, state) => {
      const touches = (owner: ScanDetectionOwner | null | undefined) =>
        !!owner && (owner.sourceModelId === scope.modelId || owner.targetModelId === scope.modelId);
      const job = state.scanDetectionJob;
      const jobEnds = job?.kind === 'running' && touches(job.owner) ? { scanDetectionJob: IDLE_RUN } : {};
      // A removed scan takes its creation history with it.
      const created = state.scanCreatedGlobalIds ?? {};
      const history = scope.modelId in created
        ? { scanCreatedGlobalIds: Object.fromEntries(Object.entries(created).filter(([id]) => id !== scope.modelId)) }
        : {};
      return touches(state.scanDetectionRun) ? { ...cleared(), ...jobEnds, ...history } : { ...jobEnds, ...history };
    },
    'all-models-cleared': () => ({ ...cleared(), scanDetectionJob: IDLE_RUN, scanCreatedGlobalIds: {} }),
  },
);

/** Proposals the review list shows under the current filter. */
export function visibleScanProposals(run: ScanDetectionRun | null, filter: ScanProposalFilter) {
  if (!run) return [];
  return run.result.proposals.proposals.filter((p) => filter.classes.includes(p.ifcClass) && p.confidence >= filter.minConfidence);
}


/**
 * The `globalIds` that are elements of `model` now: authored this session
 * (its mutation view's new entities) or in its parsed file (a reopened
 * export), and not deleted. GlobalIds, not express ids, so a reopened copy
 * of the model still recognises what was created in it.
 */
export function presentGlobalIds(
  model: FederatedModel | null | undefined,
  view: MutablePropertyView | undefined,
  globalIds: Iterable<string>,
): Set<string> {
  const present = new Set<string>();
  if (!model) return present;
  const authored = new Map<string, number>();
  for (const entity of view?.getNewEntities() ?? []) {
    const gid = entity.attributes[0];
    if (typeof gid === 'string' && !view?.isDeleted(entity.expressId)) authored.set(gid, entity.expressId);
  }
  const entities = model.ifcDataStore?.entities;
  for (const gid of globalIds) {
    if (authored.has(gid)) { present.add(gid); continue; }
    const id = entities?.getExpressIdByGlobalId(gid) ?? -1;
    if (id >= 0 && !view?.isDeleted(id)) present.add(gid);
  }
  return present;
}

/**
 * Proposals whose created element is in `target` now: an undo of the
 * creation removes the element, and the proposal can be created again.
 * `_version` (`mutationVersion`) only makes callers re-evaluate after an edit.
 */
export function liveCreatedProposalIds(
  created: Readonly<Record<string, ScanCreatedRecord>>,
  target: FederatedModel | null,
  views: ReadonlyMap<string, MutablePropertyView>,
  _version: number,
): Set<string> {
  const present = presentGlobalIds(target, target ? views.get(target.id) : undefined, Object.values(created).map((r) => r.globalId));
  return new Set(Object.entries(created).filter(([, r]) => present.has(r.globalId)).map(([id]) => id));
}
