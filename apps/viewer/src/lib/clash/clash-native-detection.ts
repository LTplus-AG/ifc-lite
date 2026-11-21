/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { clashElementCache } from '@/lib/clash/element-cache';
import { beginAbortableRun, releaseAbortableRun } from '@/hooks/analysisRunCancellation';
import { captureAnalysisStamp, stampAnalysisReport, type AnalysisStamp } from '@/hooks/useAnalysisStaleness';
import { jobPlacementIsCurrent } from '@/lib/model-placement/placement-snapshot';
import { useViewerStore } from '@/store';
import type { ClashPreset } from '@/store/slices/clashSlice';
import {
  createClashEngine,
  rulesFromPresets,
  groupDuplicateSets,
  findDuplicates,
  type ClashElement,
  type ClashResult,
  type ClashRule,
} from '@ifc-lite/clash';
import { gatherClashElements } from '@/lib/clash/gather-elements';
import { ClashSetFilterRefusal, withResolvedClashSetFilters } from '@/lib/clash/set-filter-resolve';
import { rememberFederationIdentity, type ClashFederationIdentity } from '@/lib/clash/federation-identity';
import { federationIsCurrent } from '@/lib/federation/federation-identity';
import { definedModelTagIdsOf, evaluatorModelsFromState } from '@/lib/model-tags/evaluator-models';
import { captureModelTagInputs, rememberModelTagInputs, type ClashModelTagInputs } from '@/lib/clash/model-tag-inputs';
import { allElementsRule, rememberRunRequest, type ClashRunRequest } from '@/lib/clash/run-request';
import { posthog } from '@/lib/analytics';
import { errorCaptureProps } from '@/lib/load-errors';
import { nextFrameOrTimeout } from '@/utils/frameWait';

/** Run refusals this module reports through clashError, each with its clashErrorKind (#10871). */
const CLASH_NO_GEOMETRY = 'No model geometry is loaded. Load an IFC model first.';
const CLASH_ALL_RULES_DISABLED = 'All rules are disabled — enable at least one in Clash settings (⚙).';
const CLASH_RULE_GONE = 'That rule no longer exists — pick a rule to run, or restore it in Clash settings (⚙).';
interface RunRefs {
  runEpochRef: { current: number };
  runAbortRef: { current: AbortController | null };
  discardSolidPresentation: () => void;
  publish?: (write: () => boolean) => boolean;
}
export function createClashDetection({ runEpochRef, runAbortRef, discardSolidPresentation, publish }: RunRefs) {
  const stillWanted = (epoch: number) => runEpochRef.current === epoch;
  const elementsByIdentity = clashElementCache;
  const elementIdentity = (e: Pick<ClashElement, 'model' | 'key'>) => JSON.stringify([e.model, e.key]);
  const gatherElements = gatherClashElements;
  const PAINT_FRAME_WAIT_MS = 250;
  const publishClashResult = (
    federationIdentity: ClashFederationIdentity,
    res: ClashResult,
    owns: () => boolean,
    stamp: AnalysisStamp,
    request: ClashRunRequest | null,
  ): boolean => {
    if (!owns()) return false;
    const state = useViewerStore.getState();
    if (!federationIsCurrent(federationIdentity, state.models) || !jobPlacementIsCurrent(federationIdentity, state))
      return false;
    const write = () => {
      rememberFederationIdentity(res, federationIdentity);
      rememberRunRequest(res, request);
      state.setClashResult(stampAnalysisReport(res, stamp));
      state.bumpClashRunSeq();
      return true;
    };
    return publish ? publish(write) : write();
  };
  const run = async (
    rules: ClashRule[],
    tagInputs: ClashModelTagInputs | null = null,
    request: ClashRunRequest | null = null,
    prepared?: ReturnType<typeof beginAbortableRun>,
  ): Promise<void> => {
    const {
      runEpoch: myEpoch,
      controller: abortController,
      guard,
    } = prepared ?? beginAbortableRun(runEpochRef, runAbortRef);
    const owns = (): boolean => stillWanted(myEpoch) && guard.isCurrent();
    const stamp = captureAnalysisStamp(true);
    const state = useViewerStore.getState();
    discardSolidPresentation();
    state.setClashRunning(true);
    state.setClashError(null);
    state.setClashProgress({ phase: 'broad', rule: '', done: 0, total: 0 });
    try {
      await nextFrameOrTimeout(PAINT_FRAME_WAIT_MS);
      if (!owns()) return;
      const { elements, exclusions, federationIdentity } = gatherElements();
      guard.track(federationIdentity);
      if (elements.length === 0) {
        state.setClashError(CLASH_NO_GEOMETRY, 'unavailable');
        return;
      }
      elementsByIdentity.current = new Map(elements.map((e) => [elementIdentity(e), e]));
      const engine = createClashEngine({ backend: 'ts' });
      const res = await engine.run(elements, rules, {
        exclusions,
        tolerance: state.clashTolerance,
        signal: abortController.signal,
        onProgress: (p) => {
          if (owns()) useViewerStore.getState().setClashProgress(p);
        },
      });
      if (!publishClashResult(federationIdentity, res, owns, stamp, request)) return;
      rememberModelTagInputs(res, tagInputs);
      state.setClashSelectedId(null);
      posthog.capture('clash_detection_run', {
        clash_count: res.clashes.length,
        rule_count: rules.length,
        mode: state.clashMode,
      });
    } catch (err) {
      if (!stillWanted(myEpoch)) return;
      console.error('[clash] detection run failed', err);
      state.setClashError(err instanceof Error ? err.message : String(err), 'internal');
      posthog.captureException(err, { context: 'clash_detection', ...errorCaptureProps(err) });
    } finally {
      releaseAbortableRun(abortController, runAbortRef);
      if (stillWanted(myEpoch)) {
        state.setClashRunning(false);
        state.setClashProgress(null);
      }
    }
  };
  const runPresets = async (presets: ClashPreset[], request: ClashRunRequest): Promise<void> => {
    const state = useViewerStore.getState();
    const models = evaluatorModelsFromState(state);
    const tagInputs = captureModelTagInputs(presets, state.modelTagAssignments);
    const rules = rulesFromPresets(
      presets,
      state.clashMode,
      state.clashMode === 'clearance' ? state.clashClearance : undefined,
      state.clashReportTouch,
    );
    const prepared = beginAbortableRun(runEpochRef, runAbortRef);
    const myEpoch = prepared.runEpoch;
    state.setClashError(null);
    state.setClashRunning(true);
    let resolved: ClashRule[];
    try {
      resolved = await withResolvedClashSetFilters(rules, presets, models, state.toGlobalId, {
        definedModelTagIds: definedModelTagIdsOf(state),
      });
    } catch (err) {
      if (!stillWanted(myEpoch)) return;
      state.setClashError(err instanceof Error ? err.message : String(err), err instanceof ClashSetFilterRefusal ? 'refused' : 'internal');
      releaseAbortableRun(prepared.controller, runAbortRef);
      state.setClashRunning(false);
      return;
    }
    if (!stillWanted(myEpoch)) return;
    return run(resolved, tagInputs, request, prepared);
  };
  const runMatrix = (): Promise<void> => {
    const enabled = useViewerStore.getState().clashPresets.filter((p) => p.enabled);
    if (enabled.length === 0) {
      useViewerStore.getState().setClashError(CLASH_ALL_RULES_DISABLED, 'unavailable');
      return Promise.resolve();
    }
    return runPresets(enabled, { kind: 'matrix' });
  };
  const runAll = (): Promise<void> => {
    const state = useViewerStore.getState();
    return run([allElementsRule(state.clashMode, state.clashClearance, state.clashReportTouch)], null, { kind: 'all' });
  };
  const runPreset = (presetId: string): Promise<void> => {
    const preset = useViewerStore.getState().clashPresets.find((p) => p.id === presetId);
    if (!preset) {
      useViewerStore
        .getState()
        .setClashError(CLASH_RULE_GONE, 'unknown-target');
      return Promise.resolve();
    }
    return runPresets([preset], { kind: 'preset', presetId, name: preset.name });
  };
  const runDuplicates = async (): Promise<void> => {
    const { runEpoch: myEpoch, controller: abortController, guard } = beginAbortableRun(runEpochRef, runAbortRef);
    const owns = (): boolean => stillWanted(myEpoch) && guard.isCurrent();
    const stamp = captureAnalysisStamp(true);
    const state = useViewerStore.getState();
    discardSolidPresentation();
    state.setClashRunning(true);
    state.setClashError(null);
    state.setClashProgress({ phase: 'broad', rule: 'duplicates', done: 0, total: 0 });
    try {
      await nextFrameOrTimeout(PAINT_FRAME_WAIT_MS);
      if (!owns()) return;
      const { elements, exclusions, federationIdentity } = gatherElements();
      if (elements.length === 0) {
        state.setClashError(CLASH_NO_GEOMETRY, 'unavailable');
        return;
      }
      const res = findDuplicates(elements, {
        exclusions,
        positionTolerance: state.clashDuplicateTolerance,
      });
      if (!publishClashResult(federationIdentity, res, owns, stamp, { kind: 'duplicates' })) return;
      const sets = groupDuplicateSets(res);
      state.setClashGroups(sets);
      state.setClashSelectedId(null);
      posthog.capture('clash_duplicate_scan', {
        duplicate_count: sets.length,
        pair_count: res.clashes.length,
      });
    } catch (err) {
      if (!stillWanted(myEpoch)) return;
      console.error('[clash] duplicate scan failed', err);
      state.setClashError(err instanceof Error ? err.message : String(err), 'internal');
      posthog.captureException(err, { context: 'clash_duplicates', ...errorCaptureProps(err) });
    } finally {
      releaseAbortableRun(abortController, runAbortRef);
      if (stillWanted(myEpoch)) {
        state.setClashRunning(false);
        state.setClashProgress(null);
      }
    }
  };
  return { run, runAll, runMatrix, runPreset, runDuplicates };
}
