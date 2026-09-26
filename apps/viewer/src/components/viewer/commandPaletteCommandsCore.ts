/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Ctrl/Cmd+K command palette's File/View/Tools/Visibility commands
 * (#4918 slice 3) — the first half of the table split out of
 * `CommandPalette.tsx`; `commandPaletteCommandsPanels.ts` is the rest, and
 * `commandPaletteCommands.ts` composes both. Splitting the table out is
 * what keeps `CommandPalette.tsx` under its
 * `scripts/module-size-allowlist.txt` budget once every static label
 * carries a `labelKey` (`command-palette.en.ts`) instead of a literal.
 *
 * Every row that shows fixed UI copy carries `labelKey` (via `withKey`);
 * the component calls `t()` at render. `label` stays the English text
 * search ranks against (`rankCommand` in `commandPaletteSearch.ts`) — kept
 * because search matches the literal typed query, independent of locale.
 * The recent-files loop has no `labelKey`: the filename IS the label.
 */

import {
  MousePointer2, PersonStanding, Ruler, Scissors, Home, Maximize2, Crosshair,
  ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Box, EyeOff, Eye,
  Equal, Plus, Minus, RotateCcw, SquareX, Building2, Layout,
  Palette, Sun, Orbit, FolderOpen, Clock, Save, Tag,
  PenLine, Slice, Layers3, SquareStack, ChevronsUpDown, Pencil, StickyNote,
} from 'lucide-react';
import { openRepositionModels } from '@/lib/model-placement/commands';
import { useViewerStore } from '@/store';
import { applyLevelDisplayMode } from '@/store/levelDisplay';
import { goHomeFromStore, resetVisibilityForHomeFromStore } from '@/store/homeView';
import { hideSelectionFromStore } from '@/store/hideSelection';
import {
  executeBasketSet, executeBasketAdd, executeBasketRemove, executeBasketToggleVisibility,
  executeBasketSaveView, executeBasketClear,
} from '@/store/basket/basketCommands';
import { formatFileSize, getCachedFile } from '@/lib/recent-files';
import { openSettings } from '@/lib/settings/open-settings';
import type { Command } from './commandPaletteSearch';
import { withKey, type CommandPaletteBuildParams } from './commandPaletteCommandsTypes';

export function buildCoreCommands(p: CommandPaletteBuildParams): Command[] {
  const c: Command[] = [];

  // ── File ──
  c.push(
    { id: 'file:open', label: 'Open File', ...withKey('commandPalette.file.open.label'), keywords: 'ifc ifcx glb load model browse', category: 'File', icon: FolderOpen,
      immediate: true,
      action: () => { window.dispatchEvent(new CustomEvent('ifc-lite:open-files')); } },
    { id: 'file:save-federation-setup', label: 'Save Federation Setup', ...withKey('commandPalette.file.saveFederationSetup.label'), keywords: 'federation setup save export portable models order alignment anchor', category: 'File', icon: Save, action: () => { window.dispatchEvent(new CustomEvent('ifc-lite:save-federation-setup')); } },
    { id: 'file:open-federation-setup', label: 'Open Federation Setup', ...withKey('commandPalette.file.openFederationSetup.label'), keywords: 'federation setup restore reopen import portable models order alignment anchor', category: 'File', icon: FolderOpen, immediate: true, action: () => { window.dispatchEvent(new CustomEvent('ifc-lite:open-federation-setup')); } },
    { id: 'file:model-tags', label: 'Model Tags', ...withKey('commandPalette.file.modelTags.label'), keywords: 'model tags label discipline federation organise organize', category: 'File', icon: Tag, action: () => { window.dispatchEvent(new CustomEvent('ifc-lite:edit-model-tags')); } },
  );
  for (const rf of p.recentFiles) {
    const fileName = rf.name;
    c.push({
      id: `file:recent:${fileName}`, label: fileName,
      keywords: `recent open ${formatFileSize(rf.size)}`,
      category: 'File', icon: Clock,
      detail: formatFileSize(rf.size),
      immediate: true,
      action: () => {
        if (p.cachedNames.current.has(fileName)) {
          void getCachedFile(rf).then(file => {
            if (file) window.dispatchEvent(new CustomEvent('ifc-lite:load-file', { detail: file }));
            else window.dispatchEvent(new CustomEvent('ifc-lite:open-files'));
          });
        } else {
          window.dispatchEvent(new CustomEvent('ifc-lite:open-files'));
        }
      },
    });
  }

  // ── View ──
  c.push(
    { id: 'view:home', label: 'Home', ...withKey('commandPalette.view.home.label'), keywords: 'isometric reset camera', category: 'View', icon: Home, shortcut: 'H',
      action: () => { goHomeFromStore(); } },
    { id: 'view:fit', label: 'Fit All', ...withKey('commandPalette.view.fit.label'), keywords: 'zoom extents entire model', category: 'View', icon: Maximize2, shortcut: 'Z',
      action: () => { useViewerStore.getState().cameraCallbacks.fitAll?.(); } },
    { id: 'view:frame', label: 'Frame Selection', ...withKey('commandPalette.view.frame.label'), keywords: 'zoom focus selected', category: 'View', icon: Crosshair, shortcut: 'F',
      action: () => { useViewerStore.getState().cameraCallbacks.frameSelection?.(); } },
    { id: 'view:stacked', label: 'Level — Stacked', ...withKey('commandPalette.view.stacked.label'), keywords: 'level display mode stacked default storey storeys', category: 'View', icon: Layers3,
      action: () => { applyLevelDisplayMode('stacked'); } },
    { id: 'view:exploded', label: 'Level — Exploded', ...withKey('commandPalette.view.exploded.label'), keywords: 'level display mode exploded explode lift storey storeys gap', category: 'View', icon: ChevronsUpDown,
      action: () => { applyLevelDisplayMode('exploded'); } },
    { id: 'view:solo', label: 'Level — Solo', ...withKey('commandPalette.view.solo.label'), keywords: 'level display mode solo isolate storey single only top', category: 'View', icon: SquareStack,
      action: () => { applyLevelDisplayMode('solo'); } },
    { id: 'view:projection', label: 'Projection', ...withKey('commandPalette.view.projection.label'), keywords: 'perspective orthographic ortho toggle switch', category: 'View', icon: Orbit,
      action: () => { useViewerStore.getState().toggleProjectionMode(); } },
    { id: 'view:top', label: 'Top View', ...withKey('commandPalette.view.top.label'), keywords: 'camera plan', category: 'View', icon: ArrowUp, shortcut: '1',
      action: () => { useViewerStore.getState().cameraCallbacks.setPresetView?.('top'); } },
    { id: 'view:bottom', label: 'Bottom View', ...withKey('commandPalette.view.bottom.label'), keywords: 'camera', category: 'View', icon: ArrowDown, shortcut: '2',
      action: () => { useViewerStore.getState().cameraCallbacks.setPresetView?.('bottom'); } },
    { id: 'view:front', label: 'Front View', ...withKey('commandPalette.view.front.label'), keywords: 'camera elevation', category: 'View', icon: ArrowRight, shortcut: '3',
      action: () => { useViewerStore.getState().cameraCallbacks.setPresetView?.('front'); } },
    { id: 'view:back', label: 'Back View', ...withKey('commandPalette.view.back.label'), keywords: 'camera', category: 'View', icon: ArrowLeft, shortcut: '4',
      action: () => { useViewerStore.getState().cameraCallbacks.setPresetView?.('back'); } },
    { id: 'view:left', label: 'Left View', ...withKey('commandPalette.view.left.label'), keywords: 'camera', category: 'View', icon: ArrowLeft, shortcut: '5',
      action: () => { useViewerStore.getState().cameraCallbacks.setPresetView?.('left'); } },
    { id: 'view:right', label: 'Right View', ...withKey('commandPalette.view.right.label'), keywords: 'camera', category: 'View', icon: ArrowRight, shortcut: '6',
      action: () => { useViewerStore.getState().cameraCallbacks.setPresetView?.('right'); } },
    ...(p.cesiumAvailable ? [{
      id: 'view:world', label: 'Toggle 3D World Context', ...withKey('commandPalette.view.world.label'), keywords: 'cesium globe earth satellite terrain georeference basemap context site',
      category: 'View' as const, icon: Building2,
      action: () => { useViewerStore.getState().toggleCesium(); },
    }] : []),
    { id: 'view:lighting', label: 'Environment', ...withKey('commandPalette.view.lighting.label'), keywords: 'sun sky lighting shadow solar daylight study environment preset hdri panel',
      category: 'View', icon: Sun,
      action: () => { useViewerStore.getState().toggleWorkspacePanel('environment', 'palette'); } },
    { id: 'view:spacemouse', label: 'SpaceMouse', ...withKey('commandPalette.view.spacemouse.label'), keywords: '3dconnexion space mouse navigator webhid 3d input device controller preferences settings',
      category: 'View', icon: Orbit,
      // Lives in Settings → Display → Navigation (#5509, #5857).
      action: () => { openSettings('display'); } },
  );

  // ── Tools ──
  c.push(
    { id: 'tool:select', label: 'Select', ...withKey('commandPalette.tool.select.label'), keywords: 'pick click pointer', category: 'Tools', icon: MousePointer2, shortcut: 'V',
      action: () => { useViewerStore.getState().setActiveTool('select'); } },
    { id: 'tool:walk', label: 'Walk', ...withKey('commandPalette.tool.walk.label'), keywords: 'first person navigate wasd', category: 'Tools', icon: PersonStanding, shortcut: 'C',
      action: () => { useViewerStore.getState().setActiveTool('walk'); } },
    { id: 'model:reposition', label: 'Reposition models', ...withKey('commandPalette.tool.reposition.label'), keywords: 'move align pointcloud origin offset translate', category: 'Tools', icon: Crosshair, action: () => openRepositionModels() },
    { id: 'tool:measure', label: 'Measure', ...withKey('commandPalette.tool.measure.label'), keywords: 'distance ruler dimension', category: 'Tools', icon: Ruler, shortcut: 'M',
      action: () => { useViewerStore.getState().setActiveTool('measure'); } },
    { id: 'tool:section', label: 'Section', ...withKey('commandPalette.tool.section.label'), keywords: 'clip cut plane', category: 'Tools', icon: Scissors, shortcut: 'X',
      action: () => { useViewerStore.getState().setActiveTool('section'); } },
    { id: 'tool:annotate', label: 'Annotate', ...withKey('commandPalette.tool.annotate.label'), keywords: 'pin note comment marker', category: 'Tools', icon: StickyNote, shortcut: 'P',
      action: () => { useViewerStore.getState().setActiveTool('annotate'); } },
    ...(p.canEditInSession ? [
      { id: 'tool:add-element', label: 'Add Element', ...withKey('commandPalette.tool.addElement.label'), keywords: 'wall slab beam column place drop new add element generic', category: 'Tools' as const, icon: Box,
        action: () => { useViewerStore.getState().setActiveTool('addElement'); } },
      { id: 'tool:edit-mode', label: 'Toggle Edit Mode', ...withKey('commandPalette.tool.editMode.label'), keywords: 'edit mode pen unlock readonly properties geometry author modify', category: 'Tools' as const, icon: PenLine, shortcut: 'E',
        action: () => { useViewerStore.getState().toggleEditEnabled(); } },
      { id: 'tool:split', label: 'Split selected entity', ...withKey('commandPalette.tool.split.label'), keywords: 'split cut knife slice divide segment break wall beam column slab selected', category: 'Tools' as const, icon: Slice, shortcut: 'K',
        action: () => {
          const s = useViewerStore.getState();
          const sel = s.selectedEntity;
          if (!sel) return;
          s.setSplitTarget(sel.modelId, sel.expressId);
          s.setActiveTool('split');
        } },
    ] : []),
  );

  // ── Visibility ──
  c.push(
    { id: 'vis:hide', label: 'Hide Selection', ...withKey('commandPalette.vis.hide.label'), keywords: 'hide selected invisible', category: 'Visibility', icon: EyeOff, shortcut: 'Del / Space',
      action: () => { hideSelectionFromStore(); } },
    { id: 'vis:show', label: 'Show All', ...withKey('commandPalette.vis.show.label'), keywords: 'unhide reset visible', category: 'Visibility', icon: Eye, shortcut: 'A',
      action: () => { resetVisibilityForHomeFromStore('show_all'); } },
    { id: 'vis:set-iso', label: 'Set Basket from Selection', ...withKey('commandPalette.vis.setBasket.label'), keywords: 'basket isolate set selection hierarchy view equals', category: 'Visibility', icon: Equal, shortcut: '=',
      action: () => executeBasketSet() },
    { id: 'vis:add-iso', label: 'Add to Basket', ...withKey('commandPalette.vis.addBasket.label'), keywords: 'basket plus selection hierarchy view', category: 'Visibility', icon: Plus, shortcut: '+',
      action: () => executeBasketAdd() },
    { id: 'vis:remove-iso', label: 'Remove from Basket', ...withKey('commandPalette.vis.removeBasket.label'), keywords: 'basket minus selection hierarchy view', category: 'Visibility', icon: Minus, shortcut: '−',
      action: () => executeBasketRemove() },
    { id: 'vis:toggle-iso', label: 'Toggle Basket Visibility', ...withKey('commandPalette.vis.toggleBasket.label'), keywords: 'basket show hide', category: 'Visibility', icon: Eye,
      action: () => executeBasketToggleVisibility() },
    { id: 'vis:save-view', label: 'Save Basket as View', ...withKey('commandPalette.vis.saveBasketView.label'), keywords: 'basket presentation thumbnail', category: 'Visibility', icon: Save,
      action: () => executeBasketSaveView().catch((err) => {
        console.error('[CommandPalette] Failed to save basket view:', err);
      }) },
    { id: 'vis:toggle-presentation', label: 'Toggle Basket Presentation Dock', ...withKey('commandPalette.vis.togglePresentation.label'), keywords: 'basket panel carousel thumbnails', category: 'Visibility', icon: Layout,
      // Routed through the bottom-panel table (#5508: presentation is the
      // `presentation` bottom panel now), so it stays mutually exclusive
      // with Script/Schedule/Lists/etc. instead of the raw flag toggle.
      action: () => { useViewerStore.getState().toggleBottomPanel('presentation', 'palette'); } },
    { id: 'vis:clear-iso', label: 'Clear Basket', ...withKey('commandPalette.vis.clearBasket.label'), keywords: 'basket clear reset', category: 'Visibility', icon: RotateCcw,
      action: () => executeBasketClear() },
    { id: 'vis:spaces', label: 'Spaces', ...withKey('commandPalette.vis.spaces.label'), keywords: 'IfcSpace rooms show hide', category: 'Visibility', icon: Box,
      action: () => { useViewerStore.getState().toggleTypeVisibility('spaces'); } },
    { id: 'vis:spatialZones', label: 'Spatial Zones', ...withKey('commandPalette.vis.spatialZones.label'), keywords: 'IfcSpatialZone gross area GFA show hide', category: 'Visibility', icon: Box,
      action: () => { useViewerStore.getState().toggleTypeVisibility('spatialZones'); } },
    { id: 'vis:openings', label: 'Openings', ...withKey('commandPalette.vis.openings.label'), keywords: 'IfcOpeningElement show hide', category: 'Visibility', icon: SquareX,
      action: () => { useViewerStore.getState().toggleTypeVisibility('openings'); } },
    { id: 'vis:site', label: 'Site', ...withKey('commandPalette.vis.site.label'), keywords: 'IfcSite terrain show hide', category: 'Visibility', icon: Building2,
      action: () => { useViewerStore.getState().toggleTypeVisibility('site'); } },
    { id: 'vis:ifcAnnotations', label: 'Annotations', ...withKey('commandPalette.vis.ifcAnnotations.label'), keywords: 'IfcAnnotation 2d drawing symbols text dimension leader label show hide', category: 'Visibility', icon: Pencil,
      action: () => { useViewerStore.getState().toggleTypeVisibility('ifcAnnotations'); } },
    { id: 'vis:ifcGrid', label: 'Grids', ...withKey('commandPalette.vis.ifcGrid.label'), keywords: 'IfcGrid IfcGridAxis grid axis bubble tag show hide section clip', category: 'Visibility', icon: Pencil,
      action: () => { useViewerStore.getState().toggleTypeVisibility('ifcGrid'); } },
    { id: 'vis:reset-colors', label: 'Reset Colors', ...withKey('commandPalette.vis.resetColors.label'), keywords: 'clear color override', category: 'Visibility', icon: Palette,
      action: () => { p.execute('bim.viewer.resetColors()\nconsole.log("Colors reset")'); } },
  );

  return c;
}
