/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Ribbon-only view actions. Shared camera and panel commands live in the main table. */
import { LocateFixed, Move, RotateCcw, RotateCw, ZoomIn, ZoomOut } from 'lucide-react';
import { Spatial } from '@/icons';
import { useViewerStore } from '@/store';
import type { CameraCommandId } from './toolbar/camera-commands';
import type { SurfaceCommandDefinition, SurfaceCommandState } from './surface-commands';

const ribbonOnly = ['ribbon'] as const;
const alwaysEnabled = (_state: SurfaceCommandState): boolean => true;

type RibbonViewCommandId =
  | 'view:zoom-in' | 'view:zoom-out' | 'view:rotate-left' | 'view:rotate-right'
  | 'view:move-georef' | 'view:follow-work' | 'view:centreline';

export const RIBBON_VIEW_SURFACE_COMMANDS: readonly (SurfaceCommandDefinition & { id: RibbonViewCommandId })[] = [
  {
    id: 'view:centreline', labelKey: 'ribbon.view.centreline',
    ribbonTooltipKey: 'ribbon.view.centrelineTooltip',
    keywords: 'swept disk centreline overlay', category: 'View', icon: Spatial,
    surfaces: ribbonOnly, enabled: alwaysEnabled,
    run: () => {
      const state = useViewerStore.getState();
      state.setCentrelineOverlayEnabled(!state.centrelineOverlayEnabled);
    },
  },
  {
    id: 'view:zoom-in', labelKey: 'cameraCommands.zoomIn.label',
    ribbonTooltipKey: 'cameraCommands.zoomIn.tooltip',
    keywords: 'camera zoom in', category: 'View', icon: ZoomIn,
    surfaces: ribbonOnly, enabled: alwaysEnabled,
    run: () => { useViewerStore.getState().cameraCallbacks.zoomIn?.(); },
  },
  {
    id: 'view:zoom-out', labelKey: 'cameraCommands.zoomOut.label',
    ribbonTooltipKey: 'cameraCommands.zoomOut.tooltip',
    keywords: 'camera zoom out', category: 'View', icon: ZoomOut,
    surfaces: ribbonOnly, enabled: alwaysEnabled,
    run: () => { useViewerStore.getState().cameraCallbacks.zoomOut?.(); },
  },
  {
    id: 'view:rotate-left', labelKey: 'cameraCommands.rotateLeft.label',
    ribbonTooltipKey: 'cameraCommands.rotateLeft.tooltip',
    keywords: 'camera rotate left ninety degrees', category: 'View', icon: RotateCcw,
    surfaces: ribbonOnly, enabled: alwaysEnabled,
    run: () => { useViewerStore.getState().cameraCallbacks.rotateLeft?.(); },
  },
  {
    id: 'view:rotate-right', labelKey: 'cameraCommands.rotateRight.label',
    ribbonTooltipKey: 'cameraCommands.rotateRight.tooltip',
    keywords: 'camera rotate right ninety degrees', category: 'View', icon: RotateCw,
    surfaces: ribbonOnly, enabled: alwaysEnabled,
    run: () => { useViewerStore.getState().cameraCallbacks.rotateRight?.(); },
  },
  {
    id: 'view:move-georef', labelKey: 'ribbon.view.moveGeoref',
    keywords: 'world georeference move position', category: 'View', icon: Move,
    surfaces: ribbonOnly, enabled: alwaysEnabled,
    run: () => {
      const state = useViewerStore.getState();
      const next = !state.cesiumPlacementEditMode;
      state.setCesiumPlacementEditMode(next);
      state.setActiveTool(next ? 'cesium-placement' : 'select');
    },
  },
  {
    id: 'view:follow-work', labelKey: 'ribbon.view.followWork',
    ribbonTooltipKey: 'ribbon.view.followWorkTooltip',
    keywords: 'contextual tabs follow current work', category: 'View', icon: LocateFixed,
    surfaces: ribbonOnly, enabled: alwaysEnabled,
    run: () => {
      const state = useViewerStore.getState();
      state.setRibbonContextualTabs(!state.ribbonContextualTabs);
    },
  },
];

/** The shared camera list keeps its own short ids for callbacks and ordering. */
export const CAMERA_RIBBON_COMMAND_IDS = {
  home: 'view:home', zoomIn: 'view:zoom-in', zoomOut: 'view:zoom-out',
  fitAll: 'view:fit', viewTop: 'view:top', viewBottom: 'view:bottom',
  viewFront: 'view:front', viewBack: 'view:back', viewLeft: 'view:left',
  viewRight: 'view:right', rotateLeft: 'view:rotate-left', rotateRight: 'view:rotate-right',
} as const satisfies Record<CameraCommandId, string>;
