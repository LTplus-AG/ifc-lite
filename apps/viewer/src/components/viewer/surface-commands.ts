/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Static commands shared by palette, ribbon, context menu and mobile (#5870). */

import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Building2, ChevronsUpDown,
  Crosshair, Ellipsis, FolderOpen, Home, Layers3, Maximize2, Orbit, Save,
  SquareStack, Sun, Tag,
} from 'lucide-react';
import { resolveEnglish } from '@/i18n/registry';
import { panelTitleKey } from '@/lib/panels/registry';
import { useViewerStore } from '@/store';
import { goHomeFromStore } from '@/store/homeView';
import { applyLevelDisplayMode } from '@/store/levelDisplay';
import { openSettings } from '@/lib/settings/open-settings';
import type { Command } from './commandPaletteSearch';
import { TOOL_SURFACE_COMMANDS } from './surface-commands-tools';
import { PANEL_SURFACE_COMMANDS } from './surface-commands-panels';
import { WORKSPACE_SURFACE_COMMANDS } from './surface-commands-workspace';
import { RIBBON_VIEW_SURFACE_COMMANDS } from './surface-commands-view-ribbon';
import { VISIBILITY_SURFACE_COMMANDS } from './surface-commands-visibility';
import { RIBBON_FILE_SURFACE_COMMANDS } from './surface-commands-file-ribbon';
import { MOBILE_SURFACE_COMMANDS } from './surface-commands-mobile';
import { CONTEXT_SURFACE_COMMANDS, runContextAction, runContextOr } from './surface-commands-context';
import { runSurfaceCommand } from './surface-command-run';
export type { CommandSurface, SurfaceCommandContext, SurfaceCommandDefinition, SurfaceCommandState } from './surface-command-types';
import type { CommandSurface, SurfaceCommandContext, SurfaceCommandDefinition, SurfaceCommandState } from './surface-command-types';

const alwaysEnabled = (_state: SurfaceCommandState): boolean => true;
const paletteAndRibbon = ['palette', 'ribbon'] as const;
const paletteOnly = ['palette'] as const;
const FILE_AND_VIEW_SURFACE_COMMANDS = [
  {
    id: 'file:open', labelKey: 'commandPalette.file.open.label', ribbonLabelKey: 'ribbon.file.open', ribbonTooltipKey: 'ribbon.file.openTooltip',
    keywords: 'ifc ifcx glb load model browse',
    category: 'File', icon: FolderOpen, surfaces: ['palette', 'mobile', 'ribbon'], enabled: alwaysEnabled,
    mobileLabelKey: () => 'shellChrome.mobileToolbar.openFileAriaLabel',
    immediate: true,
    run: ({ openFiles }: SurfaceCommandContext) => {
      if (openFiles) openFiles();
      else window.dispatchEvent(new CustomEvent('ifc-lite:open-files'));
    },
  },
  {
    id: 'file:save-federation-setup', labelKey: 'commandPalette.file.saveFederationSetup.label',
    keywords: 'federation setup save export portable models order alignment anchor',
    category: 'File', icon: Save, surfaces: paletteAndRibbon, enabled: alwaysEnabled,
    run: () => { window.dispatchEvent(new CustomEvent('ifc-lite:save-federation-setup')); },
  },
  {
    id: 'file:open-federation-setup', labelKey: 'commandPalette.file.openFederationSetup.label',
    keywords: 'federation setup restore reopen import portable models order alignment anchor',
    category: 'File', icon: FolderOpen, surfaces: paletteAndRibbon, enabled: alwaysEnabled,
    immediate: true,
    run: () => { window.dispatchEvent(new CustomEvent('ifc-lite:open-federation-setup')); },
  },
  {
    id: 'file:model-tags', labelKey: 'commandPalette.file.modelTags.label',
    keywords: 'model tags label discipline federation organise organize',
    category: 'File', icon: Tag, surfaces: paletteAndRibbon, enabled: alwaysEnabled,
    run: () => { window.dispatchEvent(new CustomEvent('ifc-lite:edit-model-tags')); },
  },
  {
    id: 'view:home', labelKey: 'commandPalette.view.home.label', ribbonLabelKey: 'ribbon.home.home', ribbonTooltipKey: 'ribbon.home.homeTooltip',
    searchLabel: 'Home', keywords: 'isometric fit camera', category: 'View', icon: Home,
    surfaces: ['palette', 'mobile', 'ribbon'], enabled: alwaysEnabled, shortcut: 'camera.home',
    mobileLabelKey: () => 'shellChrome.mobileToolbar.homeAriaLabel',
    run: () => { goHomeFromStore(); },
  },
  {
    id: 'view:fit', labelKey: 'commandPalette.view.fit.label', ribbonLabelKey: 'cameraCommands.fitAll.label', ribbonTooltipKey: 'cameraCommands.fitAll.tooltip',
    searchLabel: 'Fit All', keywords: 'zoom extents entire model', category: 'View', icon: Maximize2,
    surfaces: ['palette', 'mobile', 'ribbon'], enabled: alwaysEnabled, shortcut: 'camera.fitAll',
    mobileLabelKey: () => 'shellChrome.mobileToolbar.fitAllAriaLabel',
    run: () => { useViewerStore.getState().cameraCallbacks.fitAll?.(); },
  },
  {
    id: 'view:frame', labelKey: 'commandPalette.view.frame.label',
    searchLabel: 'Frame Selection', keywords: 'zoom focus selected', category: 'View', icon: Crosshair,
    surfaces: ['palette', 'mobile', 'context'], enabled: alwaysEnabled, shortcut: 'camera.frameSelection',
    mobileLabelKey: () => 'shellChrome.mobileToolbar.frameSelection',
    contextLabelKey: 'entityContextMenu.frameSelection',
    contextIcon: Maximize2,
    run: (context: SurfaceCommandContext) => runContextOr(context, () => {
      useViewerStore.getState().cameraCallbacks.frameSelection?.();
    }),
  },
  {
    id: 'view:stacked', labelKey: 'commandPalette.view.stacked.label',
    searchLabel: 'Level — Stacked', keywords: 'level display mode stacked default storey storeys',
    category: 'View', icon: Layers3, surfaces: paletteOnly, enabled: alwaysEnabled,
    run: () => { applyLevelDisplayMode('stacked'); },
  },
  {
    id: 'view:exploded', labelKey: 'commandPalette.view.exploded.label',
    searchLabel: 'Level — Exploded', keywords: 'level display mode exploded explode lift storey storeys gap',
    category: 'View', icon: ChevronsUpDown, surfaces: paletteOnly, enabled: alwaysEnabled,
    run: () => { applyLevelDisplayMode('exploded'); },
  },
  {
    id: 'view:solo', labelKey: 'commandPalette.view.solo.label',
    searchLabel: 'Level — Solo', keywords: 'level display mode solo isolate storey single only top',
    category: 'View', icon: SquareStack, surfaces: paletteOnly, enabled: alwaysEnabled,
    run: () => { applyLevelDisplayMode('solo'); },
  },
  {
    id: 'view:projection', labelKey: 'commandPalette.view.projection.label', ribbonLabelKey: 'ribbon.view.orthographic', ribbonTooltipKey: 'ribbon.view.orthographicTooltip',
    searchLabel: 'Projection', keywords: 'perspective orthographic ortho toggle switch',
    category: 'View', icon: Orbit, surfaces: ['palette', 'mobile', 'ribbon'], enabled: alwaysEnabled,
    mobileLabelKey: (state: SurfaceCommandState) => state.projectionMode === 'orthographic'
      ? 'shellChrome.mobileToolbar.perspective' : 'shellChrome.mobileToolbar.orthographic',
    run: () => { useViewerStore.getState().toggleProjectionMode(); },
  },
  {
    id: 'view:top', labelKey: 'commandPalette.view.top.label', ribbonLabelKey: 'cameraCommands.viewTop.label', ribbonTooltipKey: 'cameraCommands.viewTop.tooltip',
    searchLabel: 'Top View', keywords: 'camera plan', category: 'View', icon: ArrowUp,
    surfaces: paletteAndRibbon, enabled: alwaysEnabled, shortcut: 'camera.viewTop',
    run: () => { useViewerStore.getState().cameraCallbacks.setPresetView?.('top'); },
  },
  {
    id: 'view:bottom', labelKey: 'commandPalette.view.bottom.label', ribbonLabelKey: 'cameraCommands.viewBottom.label', ribbonTooltipKey: 'cameraCommands.viewBottom.tooltip',
    searchLabel: 'Bottom View', keywords: 'camera', category: 'View', icon: ArrowDown,
    surfaces: paletteAndRibbon, enabled: alwaysEnabled, shortcut: 'camera.viewBottom',
    run: () => { useViewerStore.getState().cameraCallbacks.setPresetView?.('bottom'); },
  },
  {
    id: 'view:front', labelKey: 'commandPalette.view.front.label', ribbonLabelKey: 'cameraCommands.viewFront.label', ribbonTooltipKey: 'cameraCommands.viewFront.tooltip',
    searchLabel: 'Front View', keywords: 'camera elevation', category: 'View', icon: ArrowRight,
    surfaces: paletteAndRibbon, enabled: alwaysEnabled, shortcut: 'camera.viewFront',
    run: () => { useViewerStore.getState().cameraCallbacks.setPresetView?.('front'); },
  },
  {
    id: 'view:back', labelKey: 'commandPalette.view.back.label', ribbonLabelKey: 'cameraCommands.viewBack.label', ribbonTooltipKey: 'cameraCommands.viewBack.tooltip',
    searchLabel: 'Back View', keywords: 'camera', category: 'View', icon: ArrowLeft,
    surfaces: paletteAndRibbon, enabled: alwaysEnabled, shortcut: 'camera.viewBack',
    run: () => { useViewerStore.getState().cameraCallbacks.setPresetView?.('back'); },
  },
  {
    id: 'view:left', labelKey: 'commandPalette.view.left.label', ribbonLabelKey: 'cameraCommands.viewLeft.label', ribbonTooltipKey: 'cameraCommands.viewLeft.tooltip',
    searchLabel: 'Left View', keywords: 'camera', category: 'View', icon: ArrowLeft,
    surfaces: paletteAndRibbon, enabled: alwaysEnabled, shortcut: 'camera.viewLeft',
    run: () => { useViewerStore.getState().cameraCallbacks.setPresetView?.('left'); },
  },
  {
    id: 'view:right', labelKey: 'commandPalette.view.right.label', ribbonLabelKey: 'cameraCommands.viewRight.label', ribbonTooltipKey: 'cameraCommands.viewRight.tooltip',
    searchLabel: 'Right View', keywords: 'camera', category: 'View', icon: ArrowRight,
    surfaces: paletteAndRibbon, enabled: alwaysEnabled, shortcut: 'camera.viewRight',
    run: () => { useViewerStore.getState().cameraCallbacks.setPresetView?.('right'); },
  },
  {
    id: 'view:world', labelKey: 'commandPalette.view.world.label', ribbonLabelKey: 'ribbon.view.world',
    searchLabel: 'Toggle 3D World Context',
    keywords: 'cesium globe earth satellite terrain georeference basemap context site',
    category: 'View', icon: Building2, surfaces: paletteAndRibbon,
    enabled: (state: SurfaceCommandState) => state.cesiumAvailable === true,
    run: () => { useViewerStore.getState().toggleCesium(); },
  },
  {
    id: 'view:lighting', labelKey: panelTitleKey('environment'), ribbonTooltipKey: 'ribbon.view.lightingTooltip',
    keywords: 'sun sky lighting shadow solar daylight study environment preset hdri panel',
    category: 'View', icon: Sun, surfaces: paletteAndRibbon, enabled: alwaysEnabled,
    run: () => { useViewerStore.getState().toggleWorkspacePanel('environment', 'palette'); },
  },
  {
    id: 'view:spacemouse', labelKey: 'commandPalette.view.spacemouse.label', ribbonLabelKey: 'ribbon.view.spaceMouse', ribbonTooltipKey: 'ribbon.view.spaceMouseTooltip',
    searchLabel: 'SpaceMouse',
    keywords: '3dconnexion space mouse navigator webhid 3d input device controller preferences settings',
    category: 'View', icon: Orbit, surfaces: paletteAndRibbon, enabled: alwaysEnabled,
    run: () => { openSettings('display'); },
  },
] as const satisfies readonly SurfaceCommandDefinition[];
const RIBBON_ENTITY_ACTIONS_SURFACE_COMMANDS = [{
  id: 'elements:entity-actions', labelKey: 'entityContextMenu.entityActions',
  keywords: 'selected entity type storey duplicate delete actions',
  category: 'Tools', icon: Ellipsis,
  surfaces: ['ribbon'], enabled: alwaysEnabled, run: runContextAction,
}] as const satisfies readonly SurfaceCommandDefinition[];
export type SurfaceCommandId =
  | (typeof FILE_AND_VIEW_SURFACE_COMMANDS)[number]['id']
  | (typeof TOOL_SURFACE_COMMANDS)[number]['id']
  | (typeof PANEL_SURFACE_COMMANDS)[number]['id']
  | (typeof WORKSPACE_SURFACE_COMMANDS)[number]['id']
  | (typeof RIBBON_VIEW_SURFACE_COMMANDS)[number]['id']
  | (typeof RIBBON_FILE_SURFACE_COMMANDS)[number]['id']
  | (typeof MOBILE_SURFACE_COMMANDS)[number]['id']
  | (typeof CONTEXT_SURFACE_COMMANDS)[number]['id']
  | (typeof RIBBON_ENTITY_ACTIONS_SURFACE_COMMANDS)[number]['id']
  | (typeof VISIBILITY_SURFACE_COMMANDS)[number]['id'];
export const SURFACE_COMMANDS: readonly (SurfaceCommandDefinition & { id: SurfaceCommandId })[] = [
  ...FILE_AND_VIEW_SURFACE_COMMANDS,
  ...TOOL_SURFACE_COMMANDS,
  ...PANEL_SURFACE_COMMANDS,
  ...WORKSPACE_SURFACE_COMMANDS,
  ...RIBBON_VIEW_SURFACE_COMMANDS,
  ...RIBBON_FILE_SURFACE_COMMANDS,
  ...MOBILE_SURFACE_COMMANDS,
  ...CONTEXT_SURFACE_COMMANDS,
  ...RIBBON_ENTITY_ACTIONS_SURFACE_COMMANDS,
  ...VISIBILITY_SURFACE_COMMANDS,
];

export function surfaceCommand<const Id extends SurfaceCommandId>(
  id: Id,
  surface: CommandSurface,
): SurfaceCommandDefinition & { readonly id: Id };
export function surfaceCommand(id: SurfaceCommandId, surface: CommandSurface): SurfaceCommandDefinition {
  const definition = SURFACE_COMMANDS.find((command) => command.id === id);
  if (!definition) throw new Error(`Unknown surface command: ${id}`);
  if (!definition.surfaces.some((registered) => registered === surface)) throw new Error(`${id} is not registered for ${surface}`);
  return definition;
}

export function paletteSurfaceCommands(
  state: SurfaceCommandState,
  execute: (code: string) => void,
  context: Pick<SurfaceCommandContext, 'activateRightPanel' | 'activateBottomPanel'> = {},
): Command[] {
  return SURFACE_COMMANDS
    .filter((command) => command.surfaces.some((surface) => surface === 'palette') && command.enabled(state))
    .map((command) => commandRowFromDefinition(command, { ...context, surface: 'palette', execute }));
}

/** One row projection for the palette and mobile command menus. */
export function commandRowFromDefinition(
  command: SurfaceCommandDefinition,
  context: SurfaceCommandContext,
): Command {
  return {
    id: command.id,
    label: command.searchLabel ?? resolveEnglish(command.labelKey),
    labelKey: command.labelKey,
    keywords: command.keywords,
    category: command.category,
    icon: command.icon,
    shortcut: command.shortcut,
    immediate: command.immediate,
    registryOwned: true,
    action: () => runSurfaceCommand(command, context),
  };
}
