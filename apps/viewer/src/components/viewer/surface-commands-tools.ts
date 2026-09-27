/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Static Tools palette family. The key-command table remains the chord source. */
import {
  Box, Crosshair, MousePointer2, PenLine, PersonStanding, Ruler, Scissors,
  Slice, StickyNote,
} from 'lucide-react';
import { openRepositionModels } from '@/lib/model-placement/commands';
import { useViewerStore } from '@/store';
import type { SurfaceCommandDefinition, SurfaceCommandState } from './surface-commands';

const paletteOnly = ['palette'] as const;
const alwaysEnabled = (_state: SurfaceCommandState): boolean => true;
const editable = (state: SurfaceCommandState): boolean => state.canEditInSession;

export const TOOL_SURFACE_COMMANDS = [
  {
    id: 'tool:select', labelKey: 'commandPalette.tool.select.label',
    searchLabel: 'Select', keywords: 'pick click pointer', category: 'Tools', icon: MousePointer2,
    surfaces: paletteOnly, enabled: alwaysEnabled, shortcut: 'tool.select',
    run: () => { useViewerStore.getState().setActiveTool('select'); },
  },
  {
    id: 'tool:walk', labelKey: 'commandPalette.tool.walk.label',
    searchLabel: 'Walk', keywords: 'first person navigate wasd', category: 'Tools', icon: PersonStanding,
    surfaces: paletteOnly, enabled: alwaysEnabled, shortcut: 'tool.walk',
    run: () => { useViewerStore.getState().setActiveTool('walk'); },
  },
  {
    id: 'model:reposition', labelKey: 'commandPalette.tool.reposition.label',
    searchLabel: 'Reposition models', keywords: 'move align pointcloud origin offset translate',
    category: 'Tools', icon: Crosshair, surfaces: paletteOnly, enabled: alwaysEnabled,
    run: () => { openRepositionModels(); },
  },
  {
    id: 'tool:measure', labelKey: 'commandPalette.tool.measure.label',
    searchLabel: 'Measure', keywords: 'distance ruler dimension', category: 'Tools', icon: Ruler,
    surfaces: paletteOnly, enabled: alwaysEnabled, shortcut: 'tool.measure',
    run: () => { useViewerStore.getState().setActiveTool('measure'); },
  },
  {
    id: 'tool:section', labelKey: 'commandPalette.tool.section.label',
    searchLabel: 'Section', keywords: 'clip cut plane', category: 'Tools', icon: Scissors,
    surfaces: paletteOnly, enabled: alwaysEnabled, shortcut: 'tool.section',
    run: () => { useViewerStore.getState().setActiveTool('section'); },
  },
  {
    id: 'tool:annotate', labelKey: 'commandPalette.tool.annotate.label',
    searchLabel: 'Annotate', keywords: 'pin note comment marker', category: 'Tools', icon: StickyNote,
    surfaces: paletteOnly, enabled: alwaysEnabled, shortcut: 'tool.annotate',
    run: () => { useViewerStore.getState().setActiveTool('annotate'); },
  },
  {
    id: 'tool:add-element', labelKey: 'commandPalette.tool.addElement.label',
    searchLabel: 'Add Element', keywords: 'wall slab beam column place drop new add element generic',
    category: 'Tools', icon: Box, surfaces: paletteOnly, enabled: editable,
    run: () => { useViewerStore.getState().setActiveTool('addElement'); },
  },
  {
    id: 'tool:edit-mode', labelKey: 'commandPalette.tool.editMode.label',
    searchLabel: 'Toggle Edit Mode', keywords: 'edit mode pen unlock readonly properties geometry author modify',
    category: 'Tools', icon: PenLine, surfaces: paletteOnly, enabled: editable,
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
      const state = useViewerStore.getState();
      const selected = state.selectedEntity;
      if (!selected) return;
      state.setSplitTarget(selected.modelId, selected.expressId);
      state.setActiveTool('split');
    },
  },
] as const satisfies readonly SurfaceCommandDefinition[];
