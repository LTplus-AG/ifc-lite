/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Palette-only prerequisites. Shared ribbon/context enabled predicates stay intact (#8947). */
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
  'view:home': 'home', 'view:fit': 'fitAll', 'view:frame': 'frameSelection',
  'view:top': 'setPresetView', 'view:bottom': 'setPresetView', 'view:front': 'setPresetView',
  'view:back': 'setPresetView', 'view:left': 'setPresetView', 'view:right': 'setPresetView',
} as const;
const selectionActions = new Set(['view:frame', 'vis:hide', 'vis:set-iso', 'vis:add-iso', 'vis:remove-iso']);
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
  const loaded = selectHasModelsLoaded(s);
  const hasData = s.ifcDataStore !== null || [...s.models.values()].some(m => m.ifcDataStore != null);
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
  return { models: s.models, data: s.ifcDataStore, geometry: s.geometryResult, loading: s.loading,
    selected: s.selectedEntity, selectedId: s.selectedEntityId, selectedIds: s.selectedEntityIds,
    activeModel: s.activeModelId, role: s.collabRole, camera: s.cameraCallbacks, cesiumAvailable: s.cesiumAvailable,
    highlight: s.hoverHighlightEnabled, mutationVersion: s.mutationVersion, georef: s.georefMutations,
    scheduleEdited: s.scheduleIsEdited, scheduleModel: s.scheduleSourceModelId,
    session: s.session, mutationViews: s.mutationViews, schedule: s.scheduleData,
    projection: s.projectionMode, theme: s.theme, levels: s.levelDisplayMode,
    edit: s.editEnabled, tips: s.hoverTooltipsEnabled, animation: s.animationEnabled,
    cesium: s.cesiumEnabled, visibility: s.typeVisibility };
}
