/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Selection, basket and IFC class visibility commands. */
import { Box, Building2, Equal, Eye, EyeOff, Layout, Minus, Palette, Pencil, Plus, RotateCcw, Save, SquareX } from 'lucide-react';
import { ACTION_NAME_KEYS } from '@/lib/commands/action-names';
import { panelTitleKey } from '@/lib/panels/registry';
import { useViewerStore } from '@/store';
import { showAllFromStore } from '@/store/homeView';
import { hideSelectionFromStore } from '@/store/hideSelection';
import {
  executeBasketAdd, executeBasketClear, executeBasketRemove, executeBasketSaveView,
  executeBasketSet, executeBasketToggleVisibility,
} from '@/store/basket/basketCommands';
import { runContextOr } from './surface-commands-context';
import type { SurfaceCommandContext, SurfaceCommandDefinition, SurfaceCommandState } from './surface-commands';

const alwaysEnabled = (_state: SurfaceCommandState): boolean => true;
const paletteAndRibbon = ['palette', 'ribbon'] as const;
const paletteOnly = ['palette'] as const;

export const VISIBILITY_SURFACE_COMMANDS = [
  {
    id: 'vis:hide', labelKey: 'commandPalette.vis.hide.label', ribbonLabelKey: 'ribbon.elements.hide', ribbonTooltipKey: 'ribbon.elements.hideTooltip',
    keywords: 'hide selected invisible', category: 'Visibility', icon: EyeOff,
    surfaces: ['palette', 'mobile', 'context', 'ribbon'], enabled: alwaysEnabled, shortcut: 'visibility.hideSelection',
    mobileLabelKey: () => 'shellChrome.mobileToolbar.hideSelection',
    contextLabelKey: 'entityContextMenu.hide',
    run: (context: SurfaceCommandContext) => runContextOr(context, hideSelectionFromStore),
  },
  {
    id: 'vis:show', labelKey: ACTION_NAME_KEYS.showAll, ribbonTooltipKey: 'ribbon.elements.showAllTooltip',
    keywords: 'unhide reset visible', category: 'Visibility', icon: Eye,
    surfaces: ['palette', 'mobile', 'context', 'ribbon'], enabled: alwaysEnabled, shortcut: 'visibility.showAll',
    run: (context: SurfaceCommandContext) => runContextOr(context, () => { showAllFromStore('show_all'); }),
  },
  {
    id: 'vis:set-iso', labelKey: 'commandPalette.vis.setBasket.label',
    searchLabel: 'Set Basket from Selection',
    keywords: 'basket isolate set selection hierarchy view equals',
    category: 'Visibility', icon: Equal, surfaces: ['palette', 'context'],
    contextLabelKey: 'entityContextMenu.setBasket',
    enabled: alwaysEnabled,
    run: (context: SurfaceCommandContext) => runContextOr(context, () => { executeBasketSet(); }),
  },
  {
    id: 'vis:add-iso', labelKey: 'commandPalette.vis.addBasket.label',
    searchLabel: 'Add to Basket',
    keywords: 'basket plus selection hierarchy view',
    category: 'Visibility', icon: Plus, surfaces: ['palette', 'context'],
    contextLabelKey: 'entityContextMenu.addToBasket',
    enabled: alwaysEnabled, shortcut: 'basket.add',
    run: (context: SurfaceCommandContext) => runContextOr(context, () => { executeBasketAdd(); }),
  },
  {
    id: 'vis:remove-iso', labelKey: 'commandPalette.vis.removeBasket.label',
    searchLabel: 'Remove from Basket',
    keywords: 'basket minus selection hierarchy view',
    category: 'Visibility', icon: Minus, surfaces: ['palette', 'context'],
    contextLabelKey: 'entityContextMenu.removeFromBasket',
    enabled: alwaysEnabled, shortcut: 'basket.remove',
    run: (context: SurfaceCommandContext) => runContextOr(context, () => { executeBasketRemove(); }),
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
    category: 'Visibility', icon: Save, surfaces: ['palette', 'context'], enabled: alwaysEnabled,
    contextLabelKey: 'entityContextMenu.saveBasketView',
    contextShortcut: 'basket.saveView',
    run: (context: SurfaceCommandContext) => runContextOr(context, () => {
      void executeBasketSaveView().catch((err: unknown) => {
        console.error('[CommandPalette] Failed to save basket view:', err);
      });
    }),
  },
  {
    id: 'vis:toggle-presentation', labelKey: 'commandPalette.vis.togglePresentation.label', ribbonLabelKey: panelTitleKey('presentation'),
    searchLabel: 'Toggle Basket Presentation Dock', keywords: 'basket panel carousel thumbnails',
    category: 'Visibility', icon: Layout, surfaces: paletteAndRibbon, enabled: alwaysEnabled,
    run: ({ surface, activateBottomPanel }: SurfaceCommandContext) => {
      if (activateBottomPanel) activateBottomPanel('presentation');
      else useViewerStore.getState().toggleBottomPanel('presentation', surface);
    },
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
