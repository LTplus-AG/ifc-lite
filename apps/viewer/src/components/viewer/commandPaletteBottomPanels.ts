/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The command-palette entries for the bottom strip's panels, one per row of
 * the bottom-panel table so a new bottom panel is one line here.
 */
import { BarChart3, CalendarClock, FileCode2, FileSpreadsheet, FileText, PencilRuler, Workflow } from 'lucide-react';
import type { BottomPanelId } from '@/lib/panels/bottom-panels';
import type { Command } from './commandPaletteSearch';
import { withPanelTitle } from './commandPaletteCommandsTypes';

// The palette keeps an English search label, derived from the same registry
// key it renders through `t()` at display time.
const ENTRIES: ReadonlyArray<Pick<Command, 'keywords' | 'icon'> & { id: BottomPanelId }> = [
  { id: 'script', keywords: 'code automation console', icon: FileCode2 },
  { id: 'lists', keywords: 'entity lists table spreadsheet', icon: FileSpreadsheet },
  { id: 'gantt', keywords: 'construction schedule 4d timeline tasks ifctask sequence playback animation', icon: CalendarClock },
  { id: 'charts', keywords: 'dashboard chart graph bar pie statistics analytics report', icon: BarChart3 },
  { id: 'flow', keywords: 'flow graph node dynamo grasshopper automation workflow script', icon: Workflow },
  { id: 'document', keywords: 'document page report template cover sheet label binding pdf print logo', icon: FileText },
  { id: 'drawing', keywords: '2d section cut plan floor plan elevation drawing sheet dxf svg pdf markup', icon: PencilRuler },
];

export function bottomPanelCommands(activate: (panel: BottomPanelId) => void): Command[] {
  return ENTRIES.map(({ id, keywords, icon }) => {
    return {
      id: `panel:${id}`, ...withPanelTitle(id), keywords, icon,
      category: 'Panels', action: () => { activate(id); },
    };
  });
}
