/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Shared homes for static viewer commands (#5870).
 *
 * The keyboard table remains the source of chords; `shortcut` references its
 * ids rather than copying a binding. Runtime rows (recent files, extensions,
 * tours) stay with their runtime providers.
 */

import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Box, Building2, ChevronsUpDown,
  Crosshair, Equal, Eye, EyeOff, FolderOpen, Home, Layers3, Layout, Maximize2,
  Minus, Orbit, Palette, Pencil, Plus, RotateCcw, Save, SquareStack, SquareX,
  Sun, Tag,
} from 'lucide-react';
import type { TranslationKey } from '@/i18n';
import { resolveEnglish } from '@/i18n/registry';
import { ACTION_NAME_KEYS } from '@/lib/commands/action-names';
import { panelTitleKey } from '@/lib/panels/registry';
import { useViewerStore } from '@/store';
import { goHomeFromStore, showAllFromStore } from '@/store/homeView';
import { hideSelectionFromStore } from '@/store/hideSelection';
import { applyLevelDisplayMode } from '@/store/levelDisplay';
import { openSettings } from '@/lib/settings/open-settings';
import {
  executeBasketAdd, executeBasketClear, executeBasketRemove, executeBasketSaveView,
  executeBasketSet, executeBasketToggleVisibility,
} from '@/store/basket/basketCommands';
import type { Command } from './commandPaletteSearch';

export type CommandSurface = 'palette' | 'ribbon' | 'context' | 'mobile';

export interface SurfaceCommandContext {
  surface: CommandSurface;
  execute?: (code: string) => void;
  resetColors?: () => void;
}

export interface SurfaceCommandState {
  canEditInSession: boolean;
  cesiumAvailable?: boolean;
}

export interface SurfaceCommandDefinition {
  id: string;
  labelKey: TranslationKey;
  /** Legacy English search text; display always uses labelKey. */
  searchLabel?: string;
  keywords: string;
  category: Command['category'];
  icon: Command['icon'];
  surfaces: readonly CommandSurface[];
  enabled: (state: SurfaceCommandState) => boolean;
  run: (context: SurfaceCommandContext) => void;
  shortcut?: Command['shortcut'];
  immediate?: boolean;
}

const alwaysEnabled = (_state: SurfaceCommandState): boolean => true;
const paletteAndRibbon = ['palette', 'ribbon'] as const;
const paletteOnly = ['palette'] as const;

export const SURFACE_COMMANDS = [
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
    id: 'view:home', labelKey: 'commandPalette.view.home.label',
    searchLabel: 'Home', keywords: 'isometric fit camera', category: 'View', icon: Home,
    surfaces: paletteOnly, enabled: alwaysEnabled, shortcut: 'camera.home',
    run: () => { goHomeFromStore(); },
  },
  {
    id: 'view:fit', labelKey: 'commandPalette.view.fit.label',
    searchLabel: 'Fit All', keywords: 'zoom extents entire model', category: 'View', icon: Maximize2,
    surfaces: paletteOnly, enabled: alwaysEnabled, shortcut: 'camera.fitAll',
    run: () => { useViewerStore.getState().cameraCallbacks.fitAll?.(); },
  },
  {
    id: 'view:frame', labelKey: 'commandPalette.view.frame.label',
    searchLabel: 'Frame Selection', keywords: 'zoom focus selected', category: 'View', icon: Crosshair,
    surfaces: paletteOnly, enabled: alwaysEnabled, shortcut: 'camera.frameSelection',
    run: () => { useViewerStore.getState().cameraCallbacks.frameSelection?.(); },
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
    id: 'view:projection', labelKey: 'commandPalette.view.projection.label',
    searchLabel: 'Projection', keywords: 'perspective orthographic ortho toggle switch',
    category: 'View', icon: Orbit, surfaces: paletteOnly, enabled: alwaysEnabled,
    run: () => { useViewerStore.getState().toggleProjectionMode(); },
  },
  {
    id: 'view:top', labelKey: 'commandPalette.view.top.label',
    searchLabel: 'Top View', keywords: 'camera plan', category: 'View', icon: ArrowUp,
    surfaces: paletteOnly, enabled: alwaysEnabled, shortcut: 'camera.viewTop',
    run: () => { useViewerStore.getState().cameraCallbacks.setPresetView?.('top'); },
  },
  {
    id: 'view:bottom', labelKey: 'commandPalette.view.bottom.label',
    searchLabel: 'Bottom View', keywords: 'camera', category: 'View', icon: ArrowDown,
    surfaces: paletteOnly, enabled: alwaysEnabled, shortcut: 'camera.viewBottom',
    run: () => { useViewerStore.getState().cameraCallbacks.setPresetView?.('bottom'); },
  },
  {
    id: 'view:front', labelKey: 'commandPalette.view.front.label',
    searchLabel: 'Front View', keywords: 'camera elevation', category: 'View', icon: ArrowRight,
    surfaces: paletteOnly, enabled: alwaysEnabled, shortcut: 'camera.viewFront',
    run: () => { useViewerStore.getState().cameraCallbacks.setPresetView?.('front'); },
  },
  {
    id: 'view:back', labelKey: 'commandPalette.view.back.label',
    searchLabel: 'Back View', keywords: 'camera', category: 'View', icon: ArrowLeft,
    surfaces: paletteOnly, enabled: alwaysEnabled, shortcut: 'camera.viewBack',
    run: () => { useViewerStore.getState().cameraCallbacks.setPresetView?.('back'); },
  },
  {
    id: 'view:left', labelKey: 'commandPalette.view.left.label',
    searchLabel: 'Left View', keywords: 'camera', category: 'View', icon: ArrowLeft,
    surfaces: paletteOnly, enabled: alwaysEnabled, shortcut: 'camera.viewLeft',
    run: () => { useViewerStore.getState().cameraCallbacks.setPresetView?.('left'); },
  },
  {
    id: 'view:right', labelKey: 'commandPalette.view.right.label',
    searchLabel: 'Right View', keywords: 'camera', category: 'View', icon: ArrowRight,
    surfaces: paletteOnly, enabled: alwaysEnabled, shortcut: 'camera.viewRight',
    run: () => { useViewerStore.getState().cameraCallbacks.setPresetView?.('right'); },
  },
  {
    id: 'view:world', labelKey: 'commandPalette.view.world.label',
    searchLabel: 'Toggle 3D World Context',
    keywords: 'cesium globe earth satellite terrain georeference basemap context site',
    category: 'View', icon: Building2, surfaces: paletteOnly,
    enabled: (state: SurfaceCommandState) => state.cesiumAvailable === true,
    run: () => { useViewerStore.getState().toggleCesium(); },
  },
  {
    id: 'view:lighting', labelKey: panelTitleKey('environment'),
    keywords: 'sun sky lighting shadow solar daylight study environment preset hdri panel',
    category: 'View', icon: Sun, surfaces: paletteOnly, enabled: alwaysEnabled,
    run: () => { useViewerStore.getState().toggleWorkspacePanel('environment', 'palette'); },
  },
  {
    id: 'view:spacemouse', labelKey: 'commandPalette.view.spacemouse.label',
    searchLabel: 'SpaceMouse',
    keywords: '3dconnexion space mouse navigator webhid 3d input device controller preferences settings',
    category: 'View', icon: Orbit, surfaces: paletteOnly, enabled: alwaysEnabled,
    run: () => { openSettings('display'); },
  },
  {
    id: 'vis:hide', labelKey: 'commandPalette.vis.hide.label',
    keywords: 'hide selected invisible', category: 'Visibility', icon: EyeOff,
    surfaces: paletteOnly, enabled: alwaysEnabled, shortcut: 'visibility.hideSelection',
    run: () => { hideSelectionFromStore(); },
  },
  {
    id: 'vis:show', labelKey: ACTION_NAME_KEYS.showAll,
    keywords: 'unhide reset visible', category: 'Visibility', icon: Eye,
    surfaces: paletteOnly, enabled: alwaysEnabled, shortcut: 'visibility.showAll',
    run: () => { showAllFromStore('show_all'); },
  },
  {
    id: 'vis:set-iso', labelKey: 'commandPalette.vis.setBasket.label',
    searchLabel: 'Set Basket from Selection',
    keywords: 'basket isolate set selection hierarchy view equals',
    category: 'Visibility', icon: Equal, surfaces: paletteOnly,
    enabled: alwaysEnabled,
    run: () => { executeBasketSet(); },
  },
  {
    id: 'vis:add-iso', labelKey: 'commandPalette.vis.addBasket.label',
    searchLabel: 'Add to Basket',
    keywords: 'basket plus selection hierarchy view',
    category: 'Visibility', icon: Plus, surfaces: paletteOnly,
    enabled: alwaysEnabled, shortcut: 'basket.add',
    run: () => { executeBasketAdd(); },
  },
  {
    id: 'vis:remove-iso', labelKey: 'commandPalette.vis.removeBasket.label',
    searchLabel: 'Remove from Basket',
    keywords: 'basket minus selection hierarchy view',
    category: 'Visibility', icon: Minus, surfaces: paletteOnly,
    enabled: alwaysEnabled, shortcut: 'basket.remove',
    run: () => { executeBasketRemove(); },
  },
  {
    id: 'vis:toggle-iso', labelKey: 'commandPalette.vis.toggleBasket.label',
    searchLabel: 'Toggle Basket Visibility',
    keywords: 'basket show hide', category: 'Visibility', icon: Eye,
    surfaces: paletteAndRibbon, enabled: alwaysEnabled,
    run: () => { executeBasketToggleVisibility(); },
  },
  {
    id: 'vis:save-view', labelKey: 'commandPalette.vis.saveBasketView.label',
    searchLabel: 'Save Basket as View', keywords: 'basket presentation thumbnail',
    category: 'Visibility', icon: Save, surfaces: paletteOnly, enabled: alwaysEnabled,
    run: () => { void executeBasketSaveView().catch((err: unknown) => {
      console.error('[CommandPalette] Failed to save basket view:', err);
    }); },
  },
  {
    id: 'vis:toggle-presentation', labelKey: 'commandPalette.vis.togglePresentation.label',
    searchLabel: 'Toggle Basket Presentation Dock', keywords: 'basket panel carousel thumbnails',
    category: 'Visibility', icon: Layout, surfaces: paletteOnly, enabled: alwaysEnabled,
    run: () => { useViewerStore.getState().toggleBottomPanel('presentation', 'palette'); },
  },
  {
    id: 'vis:clear-iso', labelKey: 'commandPalette.vis.clearBasket.label',
    searchLabel: 'Clear Basket', keywords: 'basket clear reset',
    category: 'Visibility', icon: RotateCcw, surfaces: paletteOnly, enabled: alwaysEnabled,
    run: () => { executeBasketClear(); },
  },
  {
    id: 'vis:spaces', labelKey: 'commandPalette.vis.spaces.label',
    keywords: 'IfcSpace rooms show hide', category: 'Visibility', icon: Box,
    surfaces: paletteOnly, enabled: alwaysEnabled,
    run: () => { useViewerStore.getState().toggleTypeVisibility('spaces'); },
  },
  {
    id: 'vis:spatialZones', labelKey: 'commandPalette.vis.spatialZones.label',
    keywords: 'IfcSpatialZone gross area GFA show hide', category: 'Visibility', icon: Box,
    surfaces: paletteOnly, enabled: alwaysEnabled,
    run: () => { useViewerStore.getState().toggleTypeVisibility('spatialZones'); },
  },
  {
    id: 'vis:openings', labelKey: 'commandPalette.vis.openings.label',
    keywords: 'IfcOpeningElement show hide', category: 'Visibility', icon: SquareX,
    surfaces: paletteOnly, enabled: alwaysEnabled,
    run: () => { useViewerStore.getState().toggleTypeVisibility('openings'); },
  },
  {
    id: 'vis:site', labelKey: 'commandPalette.vis.site.label',
    keywords: 'IfcSite terrain show hide', category: 'Visibility', icon: Building2,
    surfaces: paletteOnly, enabled: alwaysEnabled,
    run: () => { useViewerStore.getState().toggleTypeVisibility('site'); },
  },
  {
    id: 'vis:ifcAnnotations', labelKey: 'commandPalette.vis.ifcAnnotations.label',
    keywords: 'IfcAnnotation 2d drawing symbols text dimension leader label show hide',
    category: 'Visibility', icon: Pencil, surfaces: paletteOnly, enabled: alwaysEnabled,
    run: () => { useViewerStore.getState().toggleTypeVisibility('ifcAnnotations'); },
  },
  {
    id: 'vis:ifcGrid', labelKey: 'commandPalette.vis.ifcGrid.label',
    keywords: 'IfcGrid IfcGridAxis grid axis bubble tag show hide section clip',
    category: 'Visibility', icon: Pencil, surfaces: paletteOnly, enabled: alwaysEnabled,
    run: () => { useViewerStore.getState().toggleTypeVisibility('ifcGrid'); },
  },
  {
    id: 'vis:reset-colors', labelKey: 'commandPalette.vis.resetColors.label',
    keywords: 'clear color override', category: 'Visibility', icon: Palette,
    surfaces: paletteAndRibbon, enabled: alwaysEnabled,
    run: ({ execute, resetColors }: SurfaceCommandContext) => {
      if (resetColors) resetColors();
      else if (execute) execute('bim.viewer.resetColors()\nconsole.log("Colors reset")');
      else throw new Error('Reset Colors requires a viewer action');
    },
  },
] as const satisfies readonly SurfaceCommandDefinition[];

export type SurfaceCommandId = (typeof SURFACE_COMMANDS)[number]['id'];

export function surfaceCommand(id: SurfaceCommandId, surface: CommandSurface): SurfaceCommandDefinition {
  const definition = SURFACE_COMMANDS.find((command) => command.id === id);
  if (!definition) throw new Error(`Unknown surface command: ${id}`);
  if (!definition.surfaces.some((registered) => registered === surface)) throw new Error(`${id} is not registered for ${surface}`);
  return definition;
}

export function paletteSurfaceCommands(
  state: SurfaceCommandState,
  execute: (code: string) => void,
): Command[] {
  return SURFACE_COMMANDS
    .filter((command) => command.surfaces.includes('palette') && command.enabled(state))
    .map((command) => ({
      id: command.id,
      label: 'searchLabel' in command ? command.searchLabel : resolveEnglish(command.labelKey),
      labelKey: command.labelKey,
      keywords: command.keywords,
      category: command.category,
      icon: command.icon,
      shortcut: 'shortcut' in command ? command.shortcut : undefined,
      immediate: 'immediate' in command ? command.immediate : undefined,
      action: () => command.run({ surface: 'palette', execute }),
    }));
}
