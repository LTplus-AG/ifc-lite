/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Static Tools palette family. The key-command table remains the chord source. */
import {
  Box, Crosshair, MousePointer2, PenLine, PersonStanding, Ruler, Scissors,
  Slice, StickyNote,
} from 'lucide-react';
import { openRepositionModels } from '@/lib/model-placement/commands';
import { launchModelCommand } from '@/lib/commands/modeling/keys-workspace';
import { BeamIcon, ColumnIcon, CurtainWallIcon, DoorIcon, GridIcon, OpeningIcon, RoomIcon, SlabIcon, WallIcon, WindowIcon } from './model/model-icons';
import { useViewerStore } from '@/store';
import type { SurfaceCommandDefinition, SurfaceCommandState } from './surface-commands';

const paletteOnly = ['palette'] as const;
const paletteMobileRibbon = ['palette', 'mobile', 'ribbon'] as const;
const alwaysEnabled = (_state: SurfaceCommandState): boolean => true;
const editable = (state: SurfaceCommandState): boolean => state.canEditInSession;

export const TOOL_SURFACE_COMMANDS = [
  {
    id: 'tool:select', labelKey: 'commandPalette.tool.select.label', ribbonLabelKey: 'ribbon.home.select',
    searchLabel: 'Select', keywords: 'pick click pointer', category: 'Tools', icon: MousePointer2,
    surfaces: paletteMobileRibbon, enabled: alwaysEnabled, shortcut: 'tool.select',
    mobileLabelKey: () => 'shellChrome.mobileToolbar.selectTool',
    run: () => { useViewerStore.getState().setActiveTool('select'); },
  },
  {
    id: 'tool:walk', labelKey: 'commandPalette.tool.walk.label', ribbonLabelKey: 'ribbon.home.walk',
    searchLabel: 'Walk', keywords: 'first person navigate wasd', category: 'Tools', icon: PersonStanding,
    surfaces: paletteMobileRibbon, enabled: alwaysEnabled, shortcut: 'tool.walk',
    mobileLabelKey: () => 'shellChrome.mobileToolbar.walkMode',
    run: ({ surface }) => {
      const state = useViewerStore.getState();
      state.setActiveTool(surface === 'mobile' && state.activeTool === 'walk' ? 'select' : 'walk');
    },
  },
  {
    id: 'model:reposition', labelKey: 'commandPalette.tool.reposition.label', ribbonLabelKey: 'ribbon.home.reposition', ribbonTooltipKey: 'ribbon.home.repositionTooltip',
    searchLabel: 'Reposition models', keywords: 'move align pointcloud origin offset translate',
    category: 'Tools', icon: Crosshair, surfaces: ['palette', 'ribbon'], enabled: alwaysEnabled,
    run: () => { openRepositionModels(); },
  },
  {
    id: 'tool:measure', labelKey: 'commandPalette.tool.measure.label', ribbonLabelKey: 'ribbon.home.measure',
    searchLabel: 'Measure', keywords: 'distance ruler dimension', category: 'Tools', icon: Ruler,
    surfaces: paletteMobileRibbon, enabled: alwaysEnabled, shortcut: 'tool.measure',
    mobileLabelKey: () => 'shellChrome.mobileToolbar.measureTool',
    run: () => { useViewerStore.getState().setActiveTool('measure'); },
  },
  {
    id: 'tool:section', labelKey: 'commandPalette.tool.section.label', ribbonLabelKey: 'ribbon.home.section',
    searchLabel: 'Section', keywords: 'clip cut plane', category: 'Tools', icon: Scissors,
    surfaces: paletteMobileRibbon, enabled: alwaysEnabled, shortcut: 'tool.section',
    mobileLabelKey: () => 'shellChrome.mobileToolbar.sectionTool',
    run: () => { useViewerStore.getState().setActiveTool('section'); },
  },
  {
    id: 'tool:annotate', labelKey: 'commandPalette.tool.annotate.label', ribbonLabelKey: 'ribbon.home.annotate',
    searchLabel: 'Annotate', keywords: 'pin note comment marker', category: 'Tools', icon: StickyNote,
    surfaces: ['palette', 'ribbon'], enabled: alwaysEnabled, shortcut: 'tool.annotate',
    run: () => { useViewerStore.getState().setActiveTool('annotate'); },
  },
  {
    id: 'tool:add-element', labelKey: 'commandPalette.tool.addElement.label',
    searchLabel: 'Add Element', keywords: 'wall slab beam column place drop new add element generic',
    category: 'Tools', icon: Box, surfaces: paletteOnly, enabled: editable,
    run: () => { useViewerStore.getState().setActiveTool('addElement'); },
  },
  {
    // The Model workspace rail's Wall (#6232); enters the workspace first.
    id: 'tool:wall', labelKey: 'commandPalette.tool.wall.label',
    searchLabel: 'Draw walls', keywords: 'wall draw place model author build create',
    category: 'Tools', icon: WallIcon, surfaces: paletteOnly, enabled: editable,
    shortcut: 'model.wall',
    run: () => { launchModelCommand('wall.place'); },
  },
  {
    id: 'tool:slab', labelKey: 'commandPalette.tool.slab.label',
    searchLabel: 'Draw slabs', keywords: 'slab floor roof plate rectangle polygon draw model author build create',
    category: 'Tools', icon: SlabIcon, surfaces: paletteOnly, enabled: editable,
    shortcut: 'model.slab',
    run: () => { launchModelCommand('slab.place'); },
  },
  {
    id: 'tool:column', labelKey: 'commandPalette.tool.column.label',
    searchLabel: 'Place columns', keywords: 'column pillar post place model author build create',
    category: 'Tools', icon: ColumnIcon, surfaces: paletteOnly, enabled: editable,
    shortcut: 'model.column',
    run: () => { launchModelCommand('column.place'); },
  },
  {
    id: 'tool:beam', labelKey: 'commandPalette.tool.beam.label',
    searchLabel: 'Draw beams', keywords: 'beam member girder joist brace draw model author build create',
    category: 'Tools', icon: BeamIcon, surfaces: paletteOnly, enabled: editable,
    shortcut: 'model.beam',
    run: () => { launchModelCommand('beam.place'); },
  },
  {
    id: 'tool:room', labelKey: 'roomTool.palette',
    searchLabel: 'Make rooms', keywords: 'room space area zone auto rectangle polygon draw walls model author build create',
    category: 'Tools', icon: RoomIcon, surfaces: paletteOnly, enabled: editable,
    shortcut: 'model.room',
    run: () => { launchModelCommand('room.place'); },
  },
  {
    id: 'tool:curtain-wall', labelKey: 'curtainWall.palette',
    searchLabel: 'Place curtain walls', keywords: 'curtain wall glazing facade mullion transom panel storefront model author build create',
    category: 'Tools', icon: CurtainWallIcon, surfaces: paletteOnly, enabled: editable,
    shortcut: 'model.curtainWall',
    run: () => { launchModelCommand('curtainwall.place'); },
  },
  {
    id: 'tool:grid', labelKey: 'grid.palette',
    searchLabel: 'Place grids', keywords: 'grid axis axes structural bay column line tag bubble model author build create',
    category: 'Tools', icon: GridIcon, surfaces: paletteOnly, enabled: editable,
    shortcut: 'model.grid',
    run: () => { launchModelCommand('grid.place'); },
  },
  {
    id: 'tool:opening', labelKey: 'commandPalette.tool.opening.label',
    searchLabel: 'Cut openings', keywords: 'opening void hole cut wall recess model author build create',
    category: 'Tools', icon: OpeningIcon, surfaces: paletteOnly, enabled: editable,
    shortcut: 'model.opening',
    run: () => { launchModelCommand('opening.place'); },
  },
  {
    id: 'tool:door', labelKey: 'commandPalette.tool.door.label',
    searchLabel: 'Place doors', keywords: 'door entrance opening wall hosted place model author build create',
    category: 'Tools', icon: DoorIcon, surfaces: paletteOnly, enabled: editable,
    shortcut: 'model.door',
    run: () => { launchModelCommand('door.place'); },
  },
  {
    id: 'tool:window', labelKey: 'commandPalette.tool.window.label',
    searchLabel: 'Place windows', keywords: 'window glazing opening wall hosted sill place model author build create',
    category: 'Tools', icon: WindowIcon, surfaces: paletteOnly, enabled: editable,
    shortcut: 'model.window',
    run: () => { launchModelCommand('window.place'); },
  },
  {
    id: 'tool:edit-mode', labelKey: 'commandPalette.tool.editMode.label', ribbonLabelKey: 'ribbon.author.editMode',
    searchLabel: 'Toggle Edit Mode', keywords: 'edit mode pen unlock readonly properties geometry author modify',
    category: 'Tools', icon: PenLine, surfaces: ['palette', 'ribbon'], enabled: editable,
    shortcut: 'edit.toggleEditMode',
    run: () => { useViewerStore.getState().toggleEditEnabled(); },
  },
  {
    id: 'tool:split', labelKey: 'commandPalette.tool.split.label',
    searchLabel: 'Split selected entity',
    keywords: 'split cut knife slice divide segment break wall beam column slab selected',
    category: 'Tools', icon: Slice, surfaces: paletteOnly, enabled: editable,
    shortcut: 'tool.split',
    run: () => {
      if (useViewerStore.getState().selectedEntity) launchModelCommand('element.split', { drawsOnWorkplane: false });
    },
  },
] as const satisfies readonly SurfaceCommandDefinition[];
