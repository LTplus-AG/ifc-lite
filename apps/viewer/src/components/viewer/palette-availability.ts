/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Palette-only prerequisites. Shared ribbon/context enabled predicates stay intact (#8947). */
import { blankModelUnavailable } from '@/hooks/startBlankModel';
import { getPlacementGeorefContext } from '@/lib/geo/placement-georef-runtime';
import { hasRetainedReportHost } from './retained-report-destination';
import { getSplitWidth, splitFits } from './model/model-layout';
import type { AddKind } from './tools/SectionAddMenu';
import { selectedEntityActionTarget } from './selected-entity-actions';
import { paletteModelBlock } from './palette-model-availability';
import { hasWorkspaceHistory } from '@/lib/model-placement/history';
import { isCollabEnabled } from '@/lib/collab/config';
import type { TranslationKey } from '@/i18n';
import { useViewerStore, type ViewerState } from '@/store';
import { canMutate } from '@/store/mutation-permission';
import { hasRetainedShapeOnlyModel, RETAINED_SHAPE_ONLY_REASON } from '@/store/retainedGeometry';
import { getWebGPUStatus } from '@/hooks/useWebGPU';
import { selectCanRefreshModels, selectHasModelsLoaded } from '@/hooks/model-presence';
import { modelWorkspaceTarget } from '@/lib/commands/modeling/workspace-target';
import { sessionWorkplaneBlock } from '@/lib/commands/modeling/workspace-storeys';
import { resolveWorkplane } from '@/lib/commands/modeling/registry';
import type { SurfaceCommandContext, SurfaceCommandDefinition, SurfaceCommandState } from './surface-command-types';
import type { Command } from './commandPaletteSearch';

export type PaletteAvailability = { status: 'available' } | {
  status: 'disabled'; reasonKey: TranslationKey;
};
const available: PaletteAvailability = { status: 'available' };
const blocked = (reasonKey: TranslationKey): PaletteAvailability => ({ status: 'disabled', reasonKey });
const cameraActions = {
  'view:zoom-in': 'zoomIn', 'view:zoom-out': 'zoomOut',
  'view:rotate-left': 'rotateLeft', 'view:rotate-right': 'rotateRight',
  'view:home': 'home', 'view:fit': 'fitAll', 'view:frame': 'frameSelection',
  'view:top': 'setPresetView', 'view:bottom': 'setPresetView', 'view:front': 'setPresetView',
  'view:back': 'setPresetView', 'view:left': 'setPresetView', 'view:right': 'setPresetView',
} as const;
const selectionActions = new Set(['view:frame', 'vis:hide', 'vis:set-iso', 'vis:add-iso', 'vis:remove-iso', 'vis:isolate']);
const selectedModelTools = new Set(['tool:split', 'tool:push-pull']);
const planeFreeTools = new Set([...selectedModelTools, 'tool:space-envelope']);
const modelTools = new Set(['tool:wall', 'tool:slab', 'tool:column', 'tool:beam', 'tool:room',
  'tool:curtain-wall', 'tool:grid', 'tool:opening', 'tool:door', 'tool:window', 'tool:stair',
  'tool:railing', 'tool:split-multi', 'tool:align', 'tool:trim-extend', ...planeFreeTools]);

export function paletteAvailability(command: SurfaceCommandDefinition, context: SurfaceCommandContext,
  s: ViewerState = useViewerStore.getState(), flags?: SurfaceCommandState): PaletteAvailability {
  const canEditInSession = s.collabRole === null || s.collabRole === 'editor' || s.collabRole === 'admin';
  const state = { ...flags, canEditInSession, cesiumAvailable: s.cesiumAvailable };
  // Identify the registry's existing role restriction without changing that predicate.
  if (!canEditInSession && !command.enabled(state) && command.enabled({ ...state, canEditInSession: true })) {
    return blocked('commandPalette.availability.editor');
  }
  if (!command.enabled(state)) return blocked('commandPalette.availability.feature');
  const id = command.id;
  if (id === 'model:copy-to-storeys') {
    if (!s.session) return blocked('commandPalette.availability.ifc');
    if (!canMutate(s, s.session.modelId)) return blocked('commandPalette.availability.editor');
    if (s.selectedEntityId === null && s.selectedEntityIds.size === 0) return blocked('commandPalette.availability.selection');
  }
  if (id === 'file:new-blank') {
    if (!context.startBlank || context.fileHostIsCurrent?.() === false) return blocked('commandPalette.availability.host');
    const reason = blankModelUnavailable(s);
    if (reason) return blocked(reason);
  }
  const recoveryAction = id === 'file:cancel-load' ? 'cancel' : id === 'file:retry-load' ? 'retry'
    : id === 'file:dismiss-load-error' ? 'dismiss' : null;
  if (recoveryAction) {
    if (!context.loadRecovery) return blocked('commandPalette.availability.host');
    if (recoveryAction === 'retry' && s.loading) return blocked('commandPalette.availability.loading');
    const reason = context.loadRecovery.unavailable(recoveryAction);
    if (reason) return blocked(reason);
  }
  const modelBlock = paletteModelBlock(id, s);
  if (modelBlock) return blocked(modelBlock);
  if (id === 'elements:entity-actions' && selectedEntityActionTarget(s) === null) {
    return blocked('commandPalette.availability.rendererEntity');
  }
  if (id === 'view:move-georef') {
    if (s.cesiumPlacementEditMode) return available; // Exiting remains possible after capability loss.
    if (!s.canCollabEdit()) return blocked('commandPalette.availability.editor');
    const georef = getPlacementGeorefContext();
    if (!georef || !s.models.has(georef.modelId)) return blocked('placementPanel.georeference.emptyHint');
    if (!georef.canEdit) return blocked(georef.unavailableReason ?? 'cesiumGeo.placement.requiresProjectedCrs');
  }
  const loaded = selectHasModelsLoaded(s);
  if (id === 'panel:retained-report' && !hasRetainedReportHost()) return blocked('commandPalette.availability.retainedReport');
  if (id === 'model:plan') {
    if (s.isMobile) return blocked('commandPalette.availability.feature');
    if (!splitFits(getSplitWidth())) return blocked('modelWorkspace.plan.noRoom');
    if (s.workspaceMode !== 'model' && !modelWorkspaceTarget(s)) return blocked('commandPalette.availability.ifc');
    if (!canEditInSession || !s.canCollabEdit()) return blocked('commandPalette.availability.editor');
    if (s.loading) return blocked('commandPalette.availability.loading');
  }
  if (id.startsWith('section-add:')) {
    if (!context.addSectionPlane || context.toolHostIsCurrent?.() === false) return blocked('commandPalette.availability.host');
    if (s.loading) return blocked('commandPalette.availability.loading');
    const reason = context.sectionAddUnavailable?.(id.slice('section-add:'.length) as AddKind);
    if (reason) return blocked(reason);
  }
  if (id.startsWith('measure:')) {
    if (s.loading) return blocked('commandPalette.availability.loading');
    if (hasRetainedShapeOnlyModel(s.models)) return blocked(RETAINED_SHAPE_ONLY_REASON);
  }

  const hasData = s.ifcDataStore !== null || [...s.models.values()].some(m => m.ifcDataStore != null);
  if (id === 'author:bulk-properties' || id === 'author:import-data') {
    if (s.loading) return blocked('commandPalette.availability.loading');
    if (!hasData) return blocked('commandPalette.availability.ifc');
    const callback = id === 'author:bulk-properties' ? context.openBulkProperties : context.openImportData;
    if (!callback || context.toolHostIsCurrent?.() === false) return blocked('commandPalette.availability.host');
  }
  if (id === 'elements:class-filter' && (!context.openClassFilter || context.toolHostIsCurrent?.() === false)) {
    return blocked('commandPalette.availability.host');
  }
  if (id === 'author:undo' || id === 'author:redo') {
    if (!hasWorkspaceHistory(s, id === 'author:undo' ? 'undo' : 'redo')) {
      return blocked(id === 'author:undo' ? 'commandPalette.availability.undo' : 'commandPalette.availability.redo');
    }
  }
  if (id === 'file:share' && !isCollabEnabled()) return blocked('commandPalette.availability.feature');
  if (['file:open', 'file:add-model', 'file:refresh', 'file:share'].includes(id)) {
    const callback = id === 'file:open' ? context.openFiles : id === 'file:add-model' ? context.addModel
      : id === 'file:refresh' ? context.refreshModels : context.openShareDialog;
    if (!callback || context.fileHostIsCurrent?.() === false) return blocked('commandPalette.availability.host');
    if (id === 'file:share') {
      if (!loaded) return blocked('commandPalette.availability.model');
    } else {
      if (s.loading) return blocked('commandPalette.availability.loading');
      if (id === 'file:refresh') {
        if (!loaded) return blocked('commandPalette.availability.model');
        if (!selectCanRefreshModels(s)) return blocked('commandPalette.availability.refresh');
      } else {
        const gpu = getWebGPUStatus();
        if (gpu.checking) return blocked('commandPalette.availability.gpuChecking');
        if (!gpu.supported) return blocked('commandPalette.availability.gpu');
      }
    }
  }
  if (id === 'ui:activity' && !context.openActivity) return blocked('commandPalette.availability.host');
  if (id === 'tool:edit-mode' && !s.editEnabled && !modelWorkspaceTarget(s)) {
    return blocked('commandPalette.availability.ifc');
  }
  if (id === 'tool:measure' && hasRetainedShapeOnlyModel(s.models)) return blocked(RETAINED_SHAPE_ONLY_REASON);
  if (selectionActions.has(id) && !loaded) return blocked('commandPalette.availability.model');
  if (selectionActions.has(id) && s.selectedEntityId === null && s.selectedEntityIds.size === 0) {
    return blocked('commandPalette.availability.selection');
  }
  if (id === 'tool:space-envelope' && s.selectedEntityId === null) return blocked('spaceEnvelope.refused');
  // These legacy handlers consume the property ref; renderer selection alone cannot launch them.
  if (selectedModelTools.has(id) && !s.selectedEntity) return blocked('commandPalette.availability.entity');
  // Push/Pull initializes its actual target from the scalar renderer channel.
  if (id === 'tool:push-pull' && s.selectedEntityId === null) return blocked('commandPalette.availability.selection');
  if (modelTools.has(id)) {
    const target = s.session ?? modelWorkspaceTarget(s);
    if (!target) return blocked('commandPalette.availability.ifc');
    if (!planeFreeTools.has(id)) {
      const planeBlocked = s.session ? sessionWorkplaneBlock(s) : target.storeyId === null
        || 'refused' in resolveWorkplane(s, target.modelId, { kind: 'storey', storeyId: target.storeyId, offset: 0 });
      if (planeBlocked) return blocked('commandPalette.availability.workplane');
    }
  }
  if ((id.startsWith('vis:') && id !== 'vis:toggle-presentation') || id === 'model:reposition'
    || id === 'file:model-tags' || id === 'file:save-federation-setup'
    || ['view:stacked', 'view:exploded', 'view:solo'].includes(id)) {
    if (!loaded) return blocked('commandPalette.availability.model');
  }
  if (id.startsWith('view:orientation:')) {
    if (!loaded) return blocked('commandPalette.availability.model');
    if (!s.cameraCallbacks.setPresetDirection) return blocked('commandPalette.availability.camera');
  }
  if (id in cameraActions) {
    if (!loaded) return blocked('commandPalette.availability.model');
    const callback = cameraActions[id as keyof typeof cameraActions];
    if (!s.cameraCallbacks[callback]) return blocked('commandPalette.availability.camera');
  }
  if (id.startsWith('schedule:')) {
    if (!hasData) return blocked('commandPalette.availability.ifc');
    if (id !== 'schedule:generate' && !s.scheduleData) return blocked('commandPalette.availability.schedule');
  }
  if ((id === 'extensions:author' && !context.activateRightPanel)
    || (id === 'schedule:generate' && !context.activateBottomPanel)
    || (id === 'vis:reset-colors' && !context.execute && !context.resetColors)) {
    return blocked('commandPalette.availability.host');
  }
  if (s.loading && (modelTools.has(id) || id.startsWith('schedule:'))) {
    return blocked('commandPalette.availability.loading');
  }
  return available;
}

/** Canonical toggles with known state; do not infer state from command wording. */
export function paletteToggleState(id: string, s: ViewerState): TranslationKey | undefined {
  if (id === 'view:projection') return s.projectionMode === 'orthographic'
    ? 'shellChrome.mobileToolbar.orthographic' : 'shellChrome.mobileToolbar.perspective';
  if (id === 'pref:theme' && s.theme !== 'colorful') return s.theme === 'dark'
    ? 'settings.general.themeDark' : 'settings.general.themeLight';
  const states: Record<string, boolean> = {
    'view:centreline': s.centrelineOverlayEnabled, 'view:follow-work': s.ribbonContextualTabs,
    'view:move-georef': s.cesiumPlacementEditMode,
    'tool:edit-mode': s.editEnabled, 'pref:tooltips': s.hoverTooltipsEnabled,
    'pref:hover-outline': s.hoverHighlightEnabled,
    'view:stacked': s.levelDisplayMode === 'stacked',
    'view:exploded': s.levelDisplayMode === 'exploded', 'view:solo': s.levelDisplayMode === 'solo',
    'schedule:toggle-animation': s.animationEnabled, 'view:world': s.cesiumEnabled,
  };
  const type = id.slice(4) as keyof typeof s.typeVisibility;
  const value = id.startsWith('vis:') && type in s.typeVisibility ? s.typeVisibility[type] : states[id];
  return value === undefined ? undefined : value ? 'commandPalette.state.on' : 'commandPalette.state.off';
}

/** One central refusal boundary, shared by pointer, Enter, and the deferred frame. */
export function canRunPaletteCommand(command: Command, onRefused?: (reason: TranslationKey) => void): boolean {
  const eligibility = command.checkAvailability?.() ?? command.availability ?? available;
  if (eligibility.status === 'available') return true;
  onRefused?.(eligibility.reasonKey);
  return false;
}

/** Narrow snapshot: unrelated viewport/store updates do not rebuild the table. */
export function palettePrerequisites(s: ViewerState) {
  return { loadError: s.error, loadRetry: s.lastLoadRetry, loadErrorSeq: s.loadErrorSeq,
    loadCanceller: s.activeLoadCanceller, streamCanceller: s.activeStreamCanceller,
    workspaceMode: s.workspaceMode, canCollabEdit: s.canCollabEdit,
    centreline: s.centrelineOverlayEnabled, followWork: s.ribbonContextualTabs,
    placementEdit: s.cesiumPlacementEditMode, hierarchy: s.hierarchyMode, workspaceUndo: hasWorkspaceHistory(s, 'undo'), workspaceRedo: hasWorkspaceHistory(s, 'redo'), models: s.models, data: s.ifcDataStore, geometry: s.geometryResult, loading: s.loading,
    sectionPlane: s.sectionPlane, sectionPlanes: s.inactiveSectionPlanes, placement: s.modelPlacement,
    selected: s.selectedEntity, selectedId: s.selectedEntityId, selectedIds: s.selectedEntityIds,
    activeModel: s.activeModelId, role: s.collabRole, camera: s.cameraCallbacks, cesiumAvailable: s.cesiumAvailable,
    highlight: s.hoverHighlightEnabled, mutationVersion: s.mutationVersion, georef: s.georefMutations,
    scheduleEdited: s.scheduleIsEdited, scheduleModel: s.scheduleSourceModelId,
    session: s.session, mutationViews: s.mutationViews, schedule: s.scheduleData,
    projection: s.projectionMode, theme: s.theme, levels: s.levelDisplayMode,
    edit: s.editEnabled, tips: s.hoverTooltipsEnabled, animation: s.animationEnabled,
    cesium: s.cesiumEnabled, visibility: s.typeVisibility };
}
