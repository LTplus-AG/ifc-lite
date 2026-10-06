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
import type { ProposalClass } from '@ifc-lite/geometry/scan-proposals';
import type { ScanDetectResult, ScanDetectStage } from '@/lib/scan-to-bim/detect-job';
import { defineSliceTeardown } from '../teardown.js';

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
  result: ScanDetectResult;
}

export interface ScanProposalFilter {
  classes: readonly ProposalClass[];
  /** 0..1 */
  minConfidence: number;
}

export interface ScanDetectionSlice {
  scanDetectionStatus: 'idle' | 'running' | 'done' | 'failed';
  scanDetectionStage: ScanDetectStage | null;
  scanDetectionError: string | null;
  scanDetectionRun: ScanDetectionRun | null;
  scanProposalDecisions: Readonly<Record<string, ScanProposalDecision>>;
  scanProposalFilter: ScanProposalFilter;
  beginScanDetection: () => void;
  setScanDetectionStage: (stage: ScanDetectStage) => void;
  finishScanDetection: (run: ScanDetectionRun) => void;
  failScanDetection: (message: string) => void;
  /** Back to idle after a cancel; the previous run, if any, stays reviewable. */
  stopScanDetection: () => void;
  /** null clears a decision back to pending. */
  decideScanProposals: (ids: readonly string[], decision: ScanProposalDecision | null) => void;
  setScanProposalFilter: (patch: Partial<ScanProposalFilter>) => void;
  clearScanDetection: () => void;
}

const DEFAULT_FILTER: ScanProposalFilter = { classes: SCAN_PROPOSAL_CLASSES, minConfidence: 0 };

export const createScanDetectionSlice: StateCreator<ScanDetectionSlice, [], [], ScanDetectionSlice> = (set) => ({
  scanDetectionStatus: 'idle',
  scanDetectionStage: null,
  scanDetectionError: null,
  scanDetectionRun: null,
  scanProposalDecisions: {},
  scanProposalFilter: DEFAULT_FILTER,
  beginScanDetection: () => set({ scanDetectionStatus: 'running', scanDetectionStage: null, scanDetectionError: null }),
  setScanDetectionStage: (stage) => set({ scanDetectionStage: stage }),
  finishScanDetection: (run) => set({
    scanDetectionStatus: 'done', scanDetectionStage: null, scanDetectionError: null, scanDetectionRun: run, scanProposalDecisions: {},
  }),
  failScanDetection: (message) => set({ scanDetectionStatus: 'failed', scanDetectionStage: null, scanDetectionError: message }),
  stopScanDetection: () => set((s) => ({ scanDetectionStatus: s.scanDetectionRun ? 'done' : 'idle', scanDetectionStage: null })),
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
  clearScanDetection: () => set({
    scanDetectionStatus: 'idle', scanDetectionStage: null, scanDetectionError: null, scanDetectionRun: null, scanProposalDecisions: {},
  }),
});

const cleared = () => ({
  scanDetectionStatus: 'idle' as const,
  scanDetectionStage: null,
  scanDetectionError: null,
  scanDetectionRun: null,
  scanProposalDecisions: {},
});

export const scanDetectionTeardown = defineSliceTeardown(
  'scanDetectionSlice',
  ['scanDetectionStatus', 'scanDetectionStage', 'scanDetectionError', 'scanDetectionRun', 'scanProposalDecisions', 'scanProposalFilter'],
  {
    'session-reset': () => ({ ...cleared(), scanProposalFilter: DEFAULT_FILTER }),
    // A run belongs to its scan and its target model: either leaving ends it.
    'model-removed': (scope, state) => {
      const run = state.scanDetectionRun;
      return run && (run.sourceModelId === scope.modelId || run.targetModelId === scope.modelId) ? cleared() : {};
    },
    'all-models-cleared': () => cleared(),
  },
);

/** Proposals the review list shows under the current filter. */
export function visibleScanProposals(run: ScanDetectionRun | null, filter: ScanProposalFilter) {
  if (!run) return [];
  return run.result.proposals.proposals.filter((p) => filter.classes.includes(p.ifcClass) && p.confidence >= filter.minConfidence);
}

