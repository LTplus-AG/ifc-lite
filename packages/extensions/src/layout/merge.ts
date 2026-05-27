/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { JsonValue } from '../types.js';
import type {
  LayoutMergeConflict,
  LayoutMergeResult,
  WorkbenchLayoutState,
  WorkbenchPanelId,
  WorkbenchZoneId,
} from './types.js';

const ZONES: WorkbenchZoneId[] = ['left', 'right', 'bottom'];

export function mergeWorkbenchLayouts(
  base: WorkbenchLayoutState,
  theirs: WorkbenchLayoutState,
  ours: WorkbenchLayoutState,
): LayoutMergeResult {
  const conflicts: LayoutMergeConflict[] = [];
  const merged: WorkbenchLayoutState = {
    ...ours,
    zones: mergeZones(base, theirs, ours, conflicts),
    sizes: {
      horizontal: mergeValue(base.sizes.horizontal, theirs.sizes.horizontal, ours.sizes.horizontal, conflicts, 'split_resize', 'horizontal'),
      bottomHeight: mergeValue(base.sizes.bottomHeight, theirs.sizes.bottomHeight, ours.sizes.bottomHeight, conflicts, 'split_resize', 'bottomHeight'),
    },
    collapsed: {
      left: mergeValue(base.collapsed.left, theirs.collapsed.left, ours.collapsed.left, conflicts, 'split_resize', 'collapsed.left'),
      right: mergeValue(base.collapsed.right, theirs.collapsed.right, ours.collapsed.right, conflicts, 'split_resize', 'collapsed.right'),
      bottom: mergeValue(base.collapsed.bottom, theirs.collapsed.bottom, ours.collapsed.bottom, conflicts, 'split_resize', 'collapsed.bottom'),
    },
    activeTabs: { ...theirs.activeTabs, ...ours.activeTabs },
    floating: mergeValue(base.floating, theirs.floating, ours.floating, conflicts, 'panel_move', 'floating'),
    panelChrome: mergeRecord(base.panelChrome, theirs.panelChrome, ours.panelChrome, conflicts, 'panel_chrome'),
    personalPanels: mergeRecord(base.personalPanels, theirs.personalPanels, ours.personalPanels, conflicts, 'personal_panel'),
    workspaceModes: mergeRecord(base.workspaceModes, theirs.workspaceModes, ours.workspaceModes, conflicts, 'panel_chrome'),
    automations: mergeValue(base.automations, theirs.automations, ours.automations, conflicts, 'panel_chrome', 'automations'),
    history: [...ours.history, ...theirs.history.filter((entry) => !ours.history.some((oursEntry) => oursEntry.id === entry.id))].slice(-50),
  };
  return { merged, conflicts };
}

function mergeZones(
  base: WorkbenchLayoutState,
  theirs: WorkbenchLayoutState,
  ours: WorkbenchLayoutState,
  conflicts: LayoutMergeConflict[],
): Record<WorkbenchZoneId, WorkbenchPanelId[]> {
  const out: Record<WorkbenchZoneId, WorkbenchPanelId[]> = { left: [], right: [], bottom: [] };
  const allPanels = new Set<string>();
  for (const layout of [base, theirs, ours]) {
    for (const zone of ZONES) for (const panelId of layout.zones[zone]) allPanels.add(panelId);
  }
  for (const panelId of allPanels) {
    const baseZone = findZone(base, panelId);
    const theirZone = findZone(theirs, panelId);
    const ourZone = findZone(ours, panelId);
    const zone = resolvePanelZone(panelId, baseZone, theirZone, ourZone, conflicts);
    if (zone) out[zone].push(panelId);
  }
  for (const zone of ZONES) {
    out[zone] = orderPanels(zone, out[zone], base, theirs, ours, conflicts);
  }
  return out;
}

function resolvePanelZone(
  panelId: string,
  baseZone: WorkbenchZoneId | undefined,
  theirZone: WorkbenchZoneId | undefined,
  ourZone: WorkbenchZoneId | undefined,
  conflicts: LayoutMergeConflict[],
): WorkbenchZoneId | undefined {
  if (theirZone === ourZone) return theirZone;
  if (baseZone === ourZone) return theirZone;
  if (baseZone === theirZone) return ourZone;
  conflicts.push({
    kind: 'panel_move',
    key: panelId,
    ours: (ourZone ?? null) as JsonValue,
    theirs: (theirZone ?? null) as JsonValue,
    base: (baseZone ?? null) as JsonValue,
  });
  return ourZone ?? theirZone;
}

function orderPanels(
  zone: WorkbenchZoneId,
  panels: string[],
  base: WorkbenchLayoutState,
  theirs: WorkbenchLayoutState,
  ours: WorkbenchLayoutState,
  conflicts: LayoutMergeConflict[],
): string[] {
  const theirOrder = theirs.zones[zone].filter((id) => panels.includes(id));
  const ourOrder = ours.zones[zone].filter((id) => panels.includes(id));
  if (arraysEqual(theirOrder, ourOrder)) return ourOrder;
  if (arraysEqual(base.zones[zone].filter((id) => panels.includes(id)), ourOrder)) return theirOrder;
  if (arraysEqual(base.zones[zone].filter((id) => panels.includes(id)), theirOrder)) return ourOrder;
  conflicts.push({
    kind: 'zone_order',
    key: zone,
    ours: ourOrder as JsonValue,
    theirs: theirOrder as JsonValue,
    base: base.zones[zone] as JsonValue,
  });
  return stableUnion(ourOrder, theirOrder);
}

function mergeRecord<T>(
  base: Record<string, T>,
  theirs: Record<string, T>,
  ours: Record<string, T>,
  conflicts: LayoutMergeConflict[],
  kind: LayoutMergeConflict['kind'],
): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(theirs), ...Object.keys(ours)])) {
    out[key] = mergeValue(base[key], theirs[key], ours[key], conflicts, kind, key);
  }
  return out;
}

function mergeValue<T>(
  base: T,
  theirs: T,
  ours: T,
  conflicts: LayoutMergeConflict[],
  kind: LayoutMergeConflict['kind'],
  key: string,
): T {
  if (deepEqual(theirs, ours)) return ours;
  if (deepEqual(base, ours)) return theirs;
  if (deepEqual(base, theirs)) return ours;
  conflicts.push({ kind, key, ours: ours as JsonValue, theirs: theirs as JsonValue, base: base as JsonValue });
  return ours;
}

function findZone(layout: WorkbenchLayoutState, panelId: string): WorkbenchZoneId | undefined {
  return ZONES.find((zone) => layout.zones[zone].includes(panelId));
}

function stableUnion(a: string[], b: string[]): string[] {
  return [...a, ...b.filter((item) => !a.includes(item))];
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
