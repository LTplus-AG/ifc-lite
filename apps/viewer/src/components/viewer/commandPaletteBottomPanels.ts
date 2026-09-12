/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The command-palette entries for the bottom strip's panels, one per row of
 * the bottom-panel table so a new bottom panel is one line here.
 */
import { BarChart3, CalendarClock, FileCode2, FileSpreadsheet } from 'lucide-react';
import type { BottomPanelId } from '@/lib/panels/bottom-panels';
import type { Command } from './commandPaletteSearch';

const ENTRIES: ReadonlyArray<Pick<Command, 'label' | 'keywords' | 'icon'> & { id: BottomPanelId }> = [
  { id: 'script', label: 'Script Editor', keywords: 'code automation console', icon: FileCode2 },
  { id: 'lists', label: 'Entity Lists', keywords: 'table spreadsheet', icon: FileSpreadsheet },
  { id: 'gantt', label: 'Construction Schedule (Gantt)', keywords: '4d timeline tasks ifctask sequence playback animation', icon: CalendarClock },
  { id: 'charts', label: 'Charts', keywords: 'dashboard chart graph bar pie statistics analytics report', icon: BarChart3 },
];

export function bottomPanelCommands(activate: (panel: BottomPanelId) => void): Command[] {
  return ENTRIES.map(({ id, label, keywords, icon }) => ({
    id: `panel:${id}`, label, keywords, icon, category: 'Panels', action: () => { activate(id); },
  }));
}
