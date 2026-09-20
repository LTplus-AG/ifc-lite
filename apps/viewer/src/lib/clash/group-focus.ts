/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore, type CameraViewpoint, type ViewerState } from '@/store';
import type { Clash, ClashElementRef } from '@ifc-lite/clash';
import type { ClashFocusMode } from '@/store/slices/clashSlice';
import { toGlobalIdFromModels } from '@/store/globalId';
import { resolveEntityRefGlobalIdFromState } from '@/store/resolveEntityRef';
import { activeSectionPlane } from '@/store/section-active';
import { applyLevelDisplayMode } from '@/store/levelDisplay';
import { collectAggregatedDescendants } from '@/utils/aggregation';
import {
  resolvePresentationColorMap,
  resolvePresentationIds,
} from '@/lib/presentation/resolvePresentationIds';
import { CLASH_COLOR_A, CLASH_COLOR_B, type RGBA } from './clash-colors';
import {
  loadedGuidOccurrences,
  reconcileGuidOccurrenceColors,
  setClashColor,
} from './guid-occurrence-colors';

interface SelectionRef {
  modelId: string;
  expressId: number;
}

export interface FramedCamera {
  viewpoint: CameraViewpoint | null;
}

export interface FocusedClashGroup {
  /** Completes after framing and returns the exact camera pose that must be captured. */
  frameReady: Promise<FramedCamera | null>;
  selectedRefs: SelectionRef[];
  aRefs: SelectionRef[];
  bRefs: SelectionRef[];
  selectedGuids: string[];
  /** Every GlobalId the focused scene shows, including aggregated parts of each loaded occurrence. */
  visibleGuids: string[];
  aGuids: string[];
  bGuids: string[];
  modelIds: string[];
  sceneRevision: {
    modelRevisions: ReadonlyMap<string, object>;
    mutationVersion: number;
    hiddenEntities: ReadonlySet<number>;
    isolatedEntities: ReadonlySet<number> | null;
    ghostExceptEntities: ReadonlySet<number> | null;
    hiddenEntitiesByModel: ReadonlyMap<string, ReadonlySet<number>>;
    isolatedEntitiesByModel: ReadonlyMap<string, ReadonlySet<number>>;
    selectionRevision: number;
    clashHighlightColors: ViewerState['clashHighlightColors'];
    colorPresentationRevision: number;
    sectionPlane: ViewerState['sectionPlane'] | null;
    selectedStoreys: ViewerState['selectedStoreys'];
    levelDisplayMode: ViewerState['levelDisplayMode'];
    classFilter: ViewerState['classFilter'];
    typeVisibility: ViewerState['typeVisibility'];
    typeViewMode: ViewerState['typeViewMode'];
  };
}

const LEVEL_DISPLAY_SETTLE_FRAME_LIMIT = 120;
const ALL_TYPES_VISIBLE: ViewerState['typeVisibility'] = {
  spaces: true,
  spatialZones: true,
  openings: true,
  virtualElements: true,
  site: true,
  ifcAnnotations: true,
  ifcGrid: true,
};

/** Frame only after an Exploded -> Stacked translation has reached the renderer. */
function scheduleClashFrame(
  waitForLevelDisplayReset: boolean,
  waitForPresentationReset: boolean,
  resolve: (framed: FramedCamera | null) => void,
): void {
  let framesRemaining = LEVEL_DISPLAY_SETTLE_FRAME_LIMIT;
  let settledFrameSeen = !waitForLevelDisplayReset;
  const frameWhenReady = (): void => {
    if (waitForPresentationReset) {
      // Type filtering rebuilds the geometry passed to ViewportContainer.
      // Let that React commit paint before asking the renderer for bounds.
      waitForPresentationReset = false;
      requestAnimationFrame(frameWhenReady);
      return;
    }
    if (waitForLevelDisplayReset) {
      const state = useViewerStore.getState();
      const offsetsPending = state.appliedStoreyOffsets.size > 0
        || state.pendingMeshTranslations !== null;
      if (offsetsPending) {
        settledFrameSeen = false;
      } else if (!settledFrameSeen) {
        // The translation queue was drained in a React effect. Give the renderer
        // one paint frame before deriving bounds from the now-stacked geometry.
        settledFrameSeen = true;
        requestAnimationFrame(frameWhenReady);
        return;
      } else {
        waitForLevelDisplayReset = false;
      }
      if (waitForLevelDisplayReset) {
        framesRemaining -= 1;
        if (framesRemaining <= 0) {
          console.error('[clash] Timed out while restoring stacked geometry before framing.');
          resolve(null);
          return;
        }
        requestAnimationFrame(frameWhenReady);
        return;
      }
    }

    const frameSelection = useViewerStore.getState().cameraCallbacks.frameSelection;
    if (!frameSelection) {
      resolve(null);
      return;
    }
    try {
      // The callback remains void-compatible for existing synchronous callers,
      // while Viewport returns false specifically when it has no bounds.
      const frameResult: unknown = frameSelection(0);
      Promise.resolve(frameResult).then((didFrame) => {
        if (didFrame === false) {
          resolve(null);
          return;
        }
        resolve({ viewpoint: currentCameraViewpoint() });
      }, (error) => {
        console.error('[clash] Could not finish framing the manual clash group:', error);
        resolve(null);
      });
    } catch (error) {
      console.error('[clash] Could not frame the manual clash group:', error);
      resolve(null);
    }
  };
  requestAnimationFrame(frameWhenReady);
}

function currentCameraViewpoint(): CameraViewpoint | null {
  try {
    return useViewerStore.getState().cameraCallbacks.getViewpoint?.() ?? null;
  } catch (error) {
    console.error('[clash] Could not read the framed camera viewpoint:', error);
    return null;
  }
}

/** True while no competing navigation has changed the camera selected for capture. */
export function focusedCameraViewpointIsCurrent(framed: FramedCamera | null): boolean {
  if (!framed) return false;
  const expected = framed.viewpoint;
  const canReadCurrent = useViewerStore.getState().cameraCallbacks.getViewpoint !== undefined;
  if (!expected && !canReadCurrent) return true;
  const current = currentCameraViewpoint();
  if (!expected || !current) return false;
  return current.position.x === expected.position.x
    && current.position.y === expected.position.y
    && current.position.z === expected.position.z
    && current.target.x === expected.target.x
    && current.target.y === expected.target.y
    && current.target.z === expected.target.z
    && current.up.x === expected.up.x
    && current.up.y === expected.up.y
    && current.up.z === expected.up.z
    && current.fov === expected.fov
    && current.projectionMode === expected.projectionMode
    && current.orthoSize === expected.orthoSize;
}

function resolvedGuids(state: ReturnType<typeof useViewerStore.getState>, refs: Iterable<SelectionRef>): string[] {
  const guids = new Set<string>();
  for (const ref of refs) {
    const guid = resolveEntityRefGlobalIdFromState(state, ref);
    if (guid) guids.add(guid);
  }
  return [...guids];
}

/** Expand aggregates without collapsing two model-qualified refs onto one renderer id first. */
function expandedAggregateRefs(
  state: ReturnType<typeof useViewerStore.getState>,
  refs: Iterable<SelectionRef>,
): SelectionRef[] {
  const expanded = new Map<string, SelectionRef>();
  const add = (ref: SelectionRef) => expanded.set(`${ref.modelId}:${ref.expressId}`, ref);
  for (const ref of refs) {
    add(ref);
    const relationships = state.models.size === 0
      ? state.ifcDataStore?.relationships
      : state.models.get(ref.modelId)?.ifcDataStore?.relationships;
    if (!relationships) continue;
    for (const expressId of collectAggregatedDescendants(relationships, ref.expressId)) {
      add({ modelId: ref.modelId, expressId });
    }
  }
  return [...expanded.values()];
}

/** True while the models, authored IFC, and rendered visibility still match the focused frame. */
export function focusedSceneRevisionIsCurrent(focused: FocusedClashGroup): boolean {
  const state = useViewerStore.getState();
  const revision = focused.sceneRevision;
  if (state.models.size !== revision.modelRevisions.size) return false;
  for (const [modelId, model] of revision.modelRevisions) {
    if (state.models.get(modelId) !== model) return false;
  }
  return state.mutationVersion === revision.mutationVersion
    && state.hiddenEntities === revision.hiddenEntities
    && state.isolatedEntities === revision.isolatedEntities
    && state.ghostExceptEntities === revision.ghostExceptEntities
    && state.hiddenEntitiesByModel === revision.hiddenEntitiesByModel
    && state.isolatedEntitiesByModel === revision.isolatedEntitiesByModel
    && state.selectionRevision === revision.selectionRevision
    && state.clashHighlightColors === revision.clashHighlightColors
    && state.colorPresentationRevision === revision.colorPresentationRevision
    && activeSectionPlane(state) === revision.sectionPlane
    && state.selectedStoreys === revision.selectedStoreys
    && state.levelDisplayMode === revision.levelDisplayMode
    && state.classFilter === revision.classFilter
    && state.typeVisibility === revision.typeVisibility
    && state.typeViewMode === revision.typeViewMode;
}

/** Focus the distinct objects in a manual group through the normal selection channel. */
export function focusClashGroup(
  clashes: readonly Clash[],
  resolve: (element: ClashElementRef) => SelectionRef | null,
  applyFocusMode: (globalIds: number[], mode: ClashFocusMode) => void,
  mode: ClashFocusMode,
): FocusedClashGroup | null {
  const state = useViewerStore.getState();
  const selectionKeys = new Set<string>();
  const refs: SelectionRef[] = [];
  const aRefs = new Map<string, SelectionRef>();
  const bRefs = new Map<string, SelectionRef>();
  for (const clash of clashes) {
    for (const [side, element] of [['a', clash.a], ['b', clash.b]] as const) {
      const resolved = resolve(element);
      if (!resolved) return null;
      const selectionKey = `${resolved.modelId}:${resolved.expressId}`;
      const sideRefs = side === 'a' ? aRefs : bRefs;
      if (!sideRefs.has(selectionKey)) sideRefs.set(selectionKey, resolved);
      if (selectionKeys.has(selectionKey)) continue;
      selectionKeys.add(selectionKey);
      refs.push(resolved);
    }
  }
  if (refs.length === 0) return null;
  // An object on both sides gets one deterministic color, never two.
  for (const key of aRefs.keys()) bRefs.delete(key);
  const a = [...aRefs.values()], b = [...bRefs.values()];
  const presentationARefs = expandedAggregateRefs(state, a);
  const aPresentationKeys = new Set(presentationARefs.map(ref => `${ref.modelId}:${ref.expressId}`));
  const presentationBRefs = expandedAggregateRefs(state, b)
    .filter(ref => !aPresentationKeys.has(`${ref.modelId}:${ref.expressId}`));
  const initialColorByGuid = new Map<string, RGBA>();
  for (const ref of presentationARefs) {
    const guid = resolveEntityRefGlobalIdFromState(state, ref);
    if (guid) initialColorByGuid.set(guid, CLASH_COLOR_A);
  }
  for (const ref of presentationBRefs) {
    const guid = resolveEntityRefGlobalIdFromState(state, ref);
    if (guid && !initialColorByGuid.has(guid)) initialColorByGuid.set(guid, CLASH_COLOR_B);
  }
  const loadedOccurrences = loadedGuidOccurrences(state, initialColorByGuid.keys());
  const participatingModelIds = new Set([...refs.map(ref => ref.modelId), ...loadedOccurrences.modelIds]);
  const hiddenParticipatingModelIds = [...participatingModelIds]
    .filter(modelId => state.models.get(modelId)?.visible === false);
  // A storey filter or exploded offsets would render only a transformed
  // subset of the group, but BCF cannot serialize either presentation. Use
  // the one canonical level-display transition before framing the group.
  const waitForLevelDisplayReset = state.selectedStoreys.size > 0
    || state.levelDisplayMode === 'exploded';
  if (state.selectedStoreys.size > 0 || state.levelDisplayMode !== 'stacked') {
    applyLevelDisplayMode('stacked');
  }
  // Class filtering is a renderer visibility gate, but BCF viewpoints cannot
  // represent it. Clear it before composing the clash focus/capture state.
  const waitForPresentationReset = hiddenParticipatingModelIds.length > 0
    || state.classFilter !== null
    || !Object.values(state.typeVisibility).every(Boolean)
    || state.typeViewMode !== 'model';
  // BCF cannot serialize a viewer-only whole-model visibility toggle. Reveal
  // only models represented by the group so its selected components, colors,
  // framing, and snapshot all describe the same rendered scene.
  if (hiddenParticipatingModelIds.length > 0) {
    state.setModelsVisibility(hiddenParticipatingModelIds, true);
  }
  if (state.classFilter !== null) state.clearClassFilter();
  // Type toggles and the type-library view also remove geometry before it
  // reaches the renderer, but BCF has no equivalent presentation channel.
  // Normalize them in one render before framing so the PNG and reopened
  // viewpoint agree. This deliberately leaves the user's persisted defaults
  // alone; the capture transition is presentation state, not a preference.
  if (!Object.values(state.typeVisibility).every(Boolean) || state.typeViewMode !== 'model') {
    useViewerStore.setState({
      typeVisibility: { ...ALL_TYPES_VISIBLE },
      typeViewMode: 'model',
    });
  }
  // Renderer presentation channels match mesh ids. A geometry-less aggregate
  // therefore has to become its renderable parts through the same canonical
  // resolver used by framing, SDK visibility, and the other isolate paths.
  const exactPresentationAGlobalIds = presentationARefs
    .map(ref => toGlobalIdFromModels(state.models, ref.modelId, ref.expressId));
  const exactPresentationBGlobalIds = presentationBRefs
    .map(ref => toGlobalIdFromModels(state.models, ref.modelId, ref.expressId));
  const presentationGlobalIds = resolvePresentationIds(
    state.cameraCallbacks.resolveHighlightIds,
    [...exactPresentationAGlobalIds, ...exactPresentationBGlobalIds],
  );
  state.clearEntitySelection();
  state.clearClashFocus();
  state.setPendingColorUpdates(state.lensAppliedColors ?? new Map());
  state.setSelectedEntityIds(presentationGlobalIds);
  state.addEntitiesToSelection(refs);
  applyFocusMode(presentationGlobalIds, mode);
  const frameReady = new Promise<FramedCamera | null>((resolve) => {
    scheduleClashFrame(waitForLevelDisplayReset, waitForPresentationReset, resolve);
  });
  const presentationState = useViewerStore.getState();
  // BCF colors are keyed only by IFC GlobalId. If two loaded revisions expose
  // the same GlobalId on opposite sides, paint every occurrence amber (A wins)
  // instead of showing a split that the exported viewpoint cannot reproduce.
  const colorByGuid = initialColorByGuid;
  const clashColors = new Map<number, RGBA>();
  for (const ref of presentationARefs) {
    const guid = resolveEntityRefGlobalIdFromState(presentationState, ref);
    setClashColor(
      clashColors,
      toGlobalIdFromModels(presentationState.models, ref.modelId, ref.expressId),
      guid ? (colorByGuid.get(guid) ?? CLASH_COLOR_A) : CLASH_COLOR_A,
    );
  }
  for (const ref of presentationBRefs) {
    const globalId = toGlobalIdFromModels(presentationState.models, ref.modelId, ref.expressId);
    const guid = resolveEntityRefGlobalIdFromState(presentationState, ref);
    setClashColor(clashColors, globalId, guid ? (colorByGuid.get(guid) ?? CLASH_COLOR_B) : CLASH_COLOR_B);
  }
  const occurrences = loadedOccurrences.rendererIdsByGuid;
  for (const ref of [...presentationARefs, ...presentationBRefs]) {
    const guid = resolveEntityRefGlobalIdFromState(presentationState, ref);
    if (!guid) continue;
    occurrences.get(guid)?.add(toGlobalIdFromModels(presentationState.models, ref.modelId, ref.expressId));
  }
  reconcileGuidOccurrenceColors(colorByGuid, occurrences, clashColors);
  const presentationClashColors = resolvePresentationColorMap(
    presentationState.cameraCallbacks.resolveHighlightIds,
    clashColors,
  );
  for (const rendererId of resolvePresentationIds(
    presentationState.cameraCallbacks.resolveHighlightIds,
    exactPresentationAGlobalIds,
  )) setClashColor(presentationClashColors, rendererId, CLASH_COLOR_A);
  reconcileGuidOccurrenceColors(colorByGuid, occurrences, presentationClashColors);
  const renderedARefs = [...presentationARefs];
  const renderedBRefs: SelectionRef[] = [];
  for (const ref of presentationBRefs) {
    const globalId = toGlobalIdFromModels(presentationState.models, ref.modelId, ref.expressId);
    (presentationClashColors.get(globalId) === CLASH_COLOR_A ? renderedARefs : renderedBRefs).push(ref);
  }
  state.setClashHighlightColors(presentationClashColors);
  state.setPendingColorUpdates(presentationClashColors);
  const focusedState = useViewerStore.getState();
  // Parts painted under another loaded occurrence of a group GUID take that
  // GUID's reconciled colour; BCF addresses them by their own GlobalId.
  const withOccurrenceParts = (guids: string[], color: RGBA | null): string[] => {
    const out = new Set(guids);
    for (const [guid, partGuids] of loadedOccurrences.descendantGuidsByGuid) {
      if (color !== null && colorByGuid.get(guid) !== color) continue;
      for (const partGuid of partGuids) out.add(partGuid);
    }
    return [...out];
  };
  const selectedGuids = resolvedGuids(presentationState, refs);
  const aGuids = withOccurrenceParts(resolvedGuids(presentationState, renderedARefs), CLASH_COLOR_A);
  const bGuids = withOccurrenceParts(resolvedGuids(presentationState, renderedBRefs), CLASH_COLOR_B)
    .filter(guid => !aGuids.includes(guid));
  return {
    frameReady,
    selectedRefs: refs,
    aRefs: a,
    bRefs: b,
    selectedGuids,
    visibleGuids: withOccurrenceParts(
      resolvedGuids(presentationState, [...presentationARefs, ...presentationBRefs]), null,
    ),
    aGuids,
    bGuids,
    modelIds: [...participatingModelIds],
    sceneRevision: {
      modelRevisions: new Map(focusedState.models),
      mutationVersion: focusedState.mutationVersion,
      hiddenEntities: focusedState.hiddenEntities,
      isolatedEntities: focusedState.isolatedEntities,
      ghostExceptEntities: focusedState.ghostExceptEntities,
      hiddenEntitiesByModel: focusedState.hiddenEntitiesByModel,
      isolatedEntitiesByModel: focusedState.isolatedEntitiesByModel,
      selectionRevision: focusedState.selectionRevision,
      clashHighlightColors: focusedState.clashHighlightColors,
      colorPresentationRevision: focusedState.colorPresentationRevision,
      sectionPlane: activeSectionPlane(focusedState),
      selectedStoreys: focusedState.selectedStoreys,
      levelDisplayMode: focusedState.levelDisplayMode,
      classFilter: focusedState.classFilter,
      typeVisibility: focusedState.typeVisibility,
      typeViewMode: focusedState.typeViewMode,
    },
  };
}
