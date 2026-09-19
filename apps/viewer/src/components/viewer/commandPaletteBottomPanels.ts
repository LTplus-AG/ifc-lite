/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The command-palette entries for the bottom strip's panels, one per row of
 * the bottom-panel table so a new bottom panel is one line here.
 */
import { BarChart3, CalendarClock, FileCode2, FileSpreadsheet, FileText } from 'lucide-react';
import type { BottomPanelId } from '@/lib/panels/bottom-panels';
import type { Command } from './commandPaletteSearch';

// `labelKey` per row (#4918 slice 3) — a plain data module, no React import,
// so it cannot call `t()` itself; `CommandPalette.tsx` calls `t(labelKey)` at
// render. `label` stays the English text search ranks against.
const ENTRIES: ReadonlyArray<Pick<Command, 'label' | 'labelKey' | 'keywords' | 'icon'> & { id: BottomPanelId }> = [
  { id: 'script', label: 'Script Editor', labelKey: 'commandPalette.panel.script.label', keywords: 'code automation console', icon: FileCode2 },
  { id: 'lists', label: 'Entity Lists', labelKey: 'commandPalette.panel.lists.label', keywords: 'table spreadsheet', icon: FileSpreadsheet },
  { id: 'gantt', label: 'Construction Schedule (Gantt)', labelKey: 'commandPalette.panel.gantt.label', keywords: '4d timeline tasks ifctask sequence playback animation', icon: CalendarClock },
  { id: 'charts', label: 'Charts', labelKey: 'commandPalette.panel.charts.label', keywords: 'dashboard chart graph bar pie statistics analytics report', icon: BarChart3 },
  { id: 'document', label: 'Document', labelKey: 'commandPalette.panel.document.label', keywords: 'document page report template cover sheet label binding pdf print logo', icon: FileText },
];

export function bottomPanelCommands(activate: (panel: BottomPanelId) => void): Command[] {
  return ENTRIES.map(({ id, label, labelKey, keywords, icon }) => ({
    id: `panel:${id}`, label, labelKey, keywords, icon, category: 'Panels', action: () => { activate(id); },
  }));
}
