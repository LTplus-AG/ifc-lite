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
  MousePointer2, PersonStanding, Ruler, Scissors, Crosshair, Box,
  FolderOpen, Clock, PenLine, Slice, StickyNote,
} from 'lucide-react';
import { openRepositionModels } from '@/lib/model-placement/commands';
import { useViewerStore } from '@/store';
import { formatFileSize, getCachedFile } from '@/lib/recent-files';
import type { Command } from './commandPaletteSearch';
import { withKey, type CommandPaletteBuildParams } from './commandPaletteCommandsTypes';
import { paletteSurfaceCommands } from './surface-commands';

export function buildCoreCommands(p: CommandPaletteBuildParams): Command[] {
  const c: Command[] = [];
  const shared = paletteSurfaceCommands({ canEditInSession: p.canEditInSession, cesiumAvailable: p.cesiumAvailable }, p.execute);

  // ── File ──
  c.push(
    { id: 'file:open', label: 'Open File', ...withKey('commandPalette.file.open.label'), keywords: 'ifc ifcx glb load model browse', category: 'File', icon: FolderOpen,
      immediate: true,
      action: () => { window.dispatchEvent(new CustomEvent('ifc-lite:open-files')); } },
    ...shared.filter((command) => command.category === 'File'),
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

  // ── View ── (static rows are generated from the shared table)
  c.push(...shared.filter((command) => command.category === 'View'));

  // ── Tools ──
  c.push(
    { id: 'tool:select', label: 'Select', ...withKey('commandPalette.tool.select.label'), keywords: 'pick click pointer', category: 'Tools', icon: MousePointer2, shortcut: 'tool.select',
      action: () => { useViewerStore.getState().setActiveTool('select'); } },
    { id: 'tool:walk', label: 'Walk', ...withKey('commandPalette.tool.walk.label'), keywords: 'first person navigate wasd', category: 'Tools', icon: PersonStanding, shortcut: 'tool.walk',
      action: () => { useViewerStore.getState().setActiveTool('walk'); } },
    { id: 'model:reposition', label: 'Reposition models', ...withKey('commandPalette.tool.reposition.label'), keywords: 'move align pointcloud origin offset translate', category: 'Tools', icon: Crosshair, action: () => openRepositionModels() },
    { id: 'tool:measure', label: 'Measure', ...withKey('commandPalette.tool.measure.label'), keywords: 'distance ruler dimension', category: 'Tools', icon: Ruler, shortcut: 'tool.measure',
      action: () => { useViewerStore.getState().setActiveTool('measure'); } },
    { id: 'tool:section', label: 'Section', ...withKey('commandPalette.tool.section.label'), keywords: 'clip cut plane', category: 'Tools', icon: Scissors, shortcut: 'tool.section',
      action: () => { useViewerStore.getState().setActiveTool('section'); } },
    { id: 'tool:annotate', label: 'Annotate', ...withKey('commandPalette.tool.annotate.label'), keywords: 'pin note comment marker', category: 'Tools', icon: StickyNote, shortcut: 'tool.annotate',
      action: () => { useViewerStore.getState().setActiveTool('annotate'); } },
    ...(p.canEditInSession ? [
      { id: 'tool:add-element', label: 'Add Element', ...withKey('commandPalette.tool.addElement.label'), keywords: 'wall slab beam column place drop new add element generic', category: 'Tools' as const, icon: Box,
        action: () => { useViewerStore.getState().setActiveTool('addElement'); } },
      { id: 'tool:edit-mode', label: 'Toggle Edit Mode', ...withKey('commandPalette.tool.editMode.label'), keywords: 'edit mode pen unlock readonly properties geometry author modify', category: 'Tools' as const, icon: PenLine, shortcut: 'edit.toggleEditMode' as const,
        action: () => { useViewerStore.getState().toggleEditEnabled(); } },
      { id: 'tool:split', label: 'Split selected entity', ...withKey('commandPalette.tool.split.label'), keywords: 'split cut knife slice divide segment break wall beam column slab selected', category: 'Tools' as const, icon: Slice, shortcut: 'tool.split' as const,
        action: () => {
          const s = useViewerStore.getState();
          const sel = s.selectedEntity;
          if (!sel) return;
          s.setSplitTarget(sel.modelId, sel.expressId);
          s.setActiveTool('split');
        } },
    ] : []),
  );

  // ── Visibility ── (static rows are generated from the shared table)
  c.push(...shared.filter((command) => command.category === 'Visibility'));

  return c;
}
