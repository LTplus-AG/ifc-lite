/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Workspace-panel registry (issues #1200 / #1201).
 *
 * Single source of truth for the right-slot panels the user switches between
 * and can float: their id, label, icon and switch hotkey. The panel switcher,
 * the keyboard shortcuts and the floating-panel host all read this — the actual
 * panel components live in `ViewerLayout` / `FloatingPanelHost`, which map an id
 * to its rendered component, so this module stays free of heavy imports.
 */

import {
  Info,
  GitCompareArrows,
  MessageSquare,
  ClipboardCheck,
  Palette,
  Crosshair,
  Puzzle,
  type LucideIcon,
} from 'lucide-react';

/** Right-slot panels that participate in switching + floating. `properties` is
 *  the Information panel (the right slot's default fallback). */
export type WorkspacePanelId =
  | 'properties'
  | 'compare'
  | 'bcf'
  | 'ids'
  | 'lens'
  | 'clash'
  | 'extensions';

export interface WorkspacePanelDef {
  id: WorkspacePanelId;
  /** Full label (tooltip / floating-window title). */
  title: string;
  /** Short label for the switcher dropdown. */
  short: string;
  Icon: LucideIcon;
}

export const WORKSPACE_PANELS: readonly WorkspacePanelDef[] = [
  { id: 'properties', title: 'Information', short: 'Info', Icon: Info },
  { id: 'compare', title: 'Compare models', short: 'Compare', Icon: GitCompareArrows },
  { id: 'bcf', title: 'BCF issues', short: 'BCF', Icon: MessageSquare },
  { id: 'ids', title: 'IDS validation', short: 'IDS', Icon: ClipboardCheck },
  { id: 'lens', title: 'Lens rules', short: 'Lens', Icon: Palette },
  { id: 'clash', title: 'Clash detection', short: 'Clash', Icon: Crosshair },
  { id: 'extensions', title: 'Extensions', short: 'Extensions', Icon: Puzzle },
];

const PANEL_BY_ID = new Map<WorkspacePanelId, WorkspacePanelDef>(WORKSPACE_PANELS.map((p) => [p.id, p]));

export function getPanelDef(id: WorkspacePanelId): WorkspacePanelDef | undefined {
  return PANEL_BY_ID.get(id);
}

/** The analysis panels that `openWorkspacePanel` toggles (everything except the
 *  Information fallback, which shows when no analysis panel is open). */
export type AnalysisPanelId = Exclude<WorkspacePanelId, 'properties'>;

export function isAnalysisPanel(id: WorkspacePanelId): id is AnalysisPanelId {
  return id !== 'properties';
}
