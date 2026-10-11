/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Workspace layout presets (#6926, U03).
 *
 * A preset arranges registered panels into the hosts the viewer already has:
 * the activity-bar rail (order and visibility), the docked pane and its
 * stacked split (#1266), and the Assistant's placement preference. It never
 * introduces a new shell, never hides a panel and never touches floating
 * panels, pop-out windows, the bottom strip, the hierarchy pane or saved
 * widths. "Browse tools" (the rail's customize list and the palette) keeps
 * exposing every capability.
 *
 * This module is pure: {@link planLayoutPreset} answers "what would change"
 * for a preview, and the store adapter (`store/layoutPreset.ts`) applies the
 * same plan and keeps the user's own layout for an exact restore.
 */

import type { TranslationKey } from '@/i18n';
import type { AssistantPlacement } from '@/lib/assistant/placement';
import { isWorkspacePanelId, type WorkspacePanelId } from './registry';

export type LayoutPresetId = 'coordinator' | 'idsStudio';

export interface LayoutPresetDef {
  id: LayoutPresetId;
  titleKey: TranslationKey;
  descriptionKey: TranslationKey;
  /**
   * Rail shortcuts brought to the front, in order. Ids that are not registered
   * yet are RESERVED: kept in the definition so the panel takes its place when
   * it lands, reported in the preview, and skipped when applying.
   */
  rail: readonly string[];
  /** The docked pane's top panel and lower split half (`null` = no split). */
  primary: string;
  secondary: string | null;
  assistantPlacement: AssistantPlacement;
}

/** BIM coordinators first (charter #6812): clash triage beside its topics, checks and comparison one click away. */
export const COORDINATOR_PRESET: LayoutPresetDef = {
  id: 'coordinator',
  titleKey: 'layoutPresets.coordinator.title',
  descriptionKey: 'layoutPresets.coordinator.description',
  // `review` is the cross-analysis review workspace (P18), reserved until registered.
  rail: ['clash', 'validation', 'bcf', 'compare', 'review', 'assistant', 'changes', 'loadReport'],
  primary: 'clash',
  secondary: 'bcf',
  assistantPlacement: 'split',
};

/**
 * IDS authoring (IDS-030, UX spec §1): Studio docked with its results panel,
 * Data validation, below it, so "Run" lands one glance away; the Assistant
 * opens in the split. The viewport stays in the centre. The spec's bottom
 * grid is the Studio's own grid mode, not a dock change ("use a layout
 * preset; don't redesign the dock").
 */
export const IDS_STUDIO_PRESET: LayoutPresetDef = {
  id: 'idsStudio',
  titleKey: 'layoutPresets.idsStudio.title',
  descriptionKey: 'layoutPresets.idsStudio.description',
  rail: ['idsStudio', 'validation', 'assistant'],
  primary: 'idsStudio',
  secondary: 'validation',
  assistantPlacement: 'split',
};

export const LAYOUT_PRESETS: readonly LayoutPresetDef[] = [COORDINATOR_PRESET, IDS_STUDIO_PRESET];

export function getLayoutPreset(id: string): LayoutPresetDef | undefined {
  return LAYOUT_PRESETS.find((preset) => preset.id === id);
}

/** What the workspace looks like now, as far as a preset can change it. */
export interface WorkspaceLayoutState {
  order: readonly WorkspacePanelId[];
  hiddenIds: readonly WorkspacePanelId[];
  expanded: boolean;
  primary: WorkspacePanelId;
  secondary: WorkspacePanelId | null;
  /** Floating or popped-out panels: a preset leaves them where they are. */
  detached: ReadonlySet<WorkspacePanelId>;
  assistantPlacement: AssistantPlacement;
}

export type LayoutPresetChange =
  | { kind: 'railFirst'; ids: WorkspacePanelId[] }
  | { kind: 'railShown'; ids: WorkspacePanelId[] }
  | { kind: 'expand' }
  | { kind: 'dock'; primary: WorkspacePanelId; secondary: WorkspacePanelId | null }
  | { kind: 'keepDetached'; ids: WorkspacePanelId[] }
  | { kind: 'assistant'; placement: AssistantPlacement }
  | { kind: 'reserved'; ids: string[] };

export interface LayoutPresetPlan {
  order: WorkspacePanelId[];
  hiddenIds: WorkspacePanelId[];
  /** `null` = leave the docked pane as it is (the panel is floating / popped out). */
  primary: WorkspacePanelId | null;
  secondary: WorkspacePanelId | null;
  assistantPlacement: AssistantPlacement;
  /** Only what differs from the current state, in reading order. */
  changes: LayoutPresetChange[];
}

/** The rail leaders stay at the top: Hierarchy's home and the Information fallback. */
const LEADERS: ReadonlySet<WorkspacePanelId> = new Set(['hierarchy', 'properties']);

export function planLayoutPreset(current: WorkspaceLayoutState, preset: LayoutPresetDef): LayoutPresetPlan {
  const registered = preset.rail.filter(isWorkspacePanelId);
  const reserved = preset.rail.filter((id) => !isWorkspacePanelId(id));
  const chosen = new Set<WorkspacePanelId>(registered);
  const leaders = current.order.filter((id) => LEADERS.has(id) && !chosen.has(id));
  const rest = current.order.filter((id) => !LEADERS.has(id) && !chosen.has(id));
  const order = [...leaders, ...registered, ...rest];
  const shown = registered.filter((id) => current.hiddenIds.includes(id));
  const hiddenIds = current.hiddenIds.filter((id) => !chosen.has(id));

  const wantPrimary = isWorkspacePanelId(preset.primary) ? preset.primary : null;
  const wantSecondary = preset.secondary !== null && isWorkspacePanelId(preset.secondary) ? preset.secondary : null;
  const keepDetached = [wantPrimary, wantSecondary].filter((id): id is WorkspacePanelId => id !== null && current.detached.has(id));
  const primary = wantPrimary && !current.detached.has(wantPrimary) ? wantPrimary : null;
  const secondary = primary && wantSecondary && wantSecondary !== primary && !current.detached.has(wantSecondary) ? wantSecondary : null;

  const changes: LayoutPresetChange[] = [];
  const railMoved = registered.some((id, index) => current.order[leaders.length + index] !== id);
  if (railMoved) changes.push({ kind: 'railFirst', ids: registered });
  if (shown.length) changes.push({ kind: 'railShown', ids: shown });
  if (!current.expanded) changes.push({ kind: 'expand' });
  if (primary && (primary !== current.primary || secondary !== current.secondary)) changes.push({ kind: 'dock', primary, secondary });
  if (keepDetached.length) changes.push({ kind: 'keepDetached', ids: keepDetached });
  if (preset.assistantPlacement !== current.assistantPlacement) changes.push({ kind: 'assistant', placement: preset.assistantPlacement });
  if (reserved.length) changes.push({ kind: 'reserved', ids: reserved });

  return { order, hiddenIds, primary, secondary, assistantPlacement: preset.assistantPlacement, changes };
}
