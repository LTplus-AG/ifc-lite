/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { create } from 'zustand';
import { createContentLibrary, initialContentStatus, type ContentStatus } from '../storage/content-library';
import type { ContentDefinition } from '../storage/content-migration';
import { MANUAL_CLASH_GROUPS_KEY, normalizeManualClashGroups, type ManualClashGroup } from './manual-groups';

export interface ClashGroupWorkspace { version: 1; id: string; name: string; groups: ManualClashGroup[] }
export const DEFAULT_GROUP_WORKSPACE = 'manual-clash-groups';
export const EMPTY_MANUAL_GROUPS: ManualClashGroup[] = [];
const string = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;

/** Whole partitions commit together: independent item writes could claim the same finding twice. */
export function decodeClashGroupWorkspace(value: unknown): ClashGroupWorkspace | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1 || !string(raw.id, 200) || !string(raw.name, 200) || !Array.isArray(raw.groups)
    || raw.groups.length > 200) return null;
  for (const group of raw.groups) {
    if (!group || typeof group !== 'object') return null;
    const item = group as Record<string, unknown>;
    if (!string(item.id, 200) || !string(item.name, 100) || !Array.isArray(item.members) || !item.members.length || item.members.length > 2000) return null;
    for (const member of item.members) {
      if (!member || typeof member !== 'object') return null;
      const ref = member as Record<string, unknown>;
      if (!string(ref.reviewKey, 10_000) || typeof ref.occurrenceKey !== 'string' || ref.occurrenceKey.length > 10_000) return null;
    }
  }
  const originalGroups = raw.groups;
  const groups = normalizeManualClashGroups(originalGroups);
  // A durable write/import never silently drops overlapping, duplicate or invalid claims.
  if (groups.length !== originalGroups.length || groups.some((group, index) => {
    const original = originalGroups[index] as ManualClashGroup;
    return group.id !== original.id || group.name !== original.name || group.members.length !== original.members.length;
  })) return null;
  return { version: 1, id: raw.id, name: raw.name, groups };
}

export const clashGroupsContent: ContentDefinition<ClashGroupWorkspace> = {
  kind: 'clashGroups', legacyKey: MANUAL_CLASH_GROUPS_KEY, decode: decodeClashGroupWorkspace,
  readLegacy(value) {
    if (!Array.isArray(value) && (!value || typeof value !== 'object' || !Array.isArray((value as { groups?: unknown }).groups))) {
      throw new Error('Legacy clash grouping workspace is invalid');
    }
    const groups = normalizeManualClashGroups(value).filter(group => decodeClashGroupWorkspace({
      version: 1, id: DEFAULT_GROUP_WORKSPACE, name: 'Manual clash groups', groups: [group],
    }));
    const original = Array.isArray(value) ? value : (value as { groups: unknown[] }).groups;
    return { entries: [{ version: 1, id: DEFAULT_GROUP_WORKSPACE, name: 'Manual clash groups', groups }],
      recovered: JSON.stringify(original) !== JSON.stringify(groups) };
  },
};

export const useClashGroupLibrary = create<{
  entries: ClashGroupWorkspace[]; status: ContentStatus; activeId: string;
}>(() => ({ entries: [], status: initialContentStatus(), activeId: DEFAULT_GROUP_WORKSPACE }));
export const clashGroupLibrary = createContentLibrary(clashGroupsContent,
  () => useClashGroupLibrary.getState().entries,
  (entries, status) => useClashGroupLibrary.setState(state => ({ entries, status,
    activeId: entries.some(entry => entry.id === state.activeId) ? state.activeId : DEFAULT_GROUP_WORKSPACE })));

/** A staged draft stays visible on refusal; the shared native notice reports its actual save state. */
export function saveCurrentClashGroups(groups: ManualClashGroup[]): boolean {
  const state = useClashGroupLibrary.getState();
  if (state.status.phase !== 'ready') return false;
  const current = state.entries.find(entry => entry.id === state.activeId);
  if (!current && state.activeId !== DEFAULT_GROUP_WORKSPACE) return false;
  const workspace: ClashGroupWorkspace = { version: 1, id: state.activeId, name: current?.name ?? 'Manual clash groups', groups };
  if (!decodeClashGroupWorkspace(workspace)) return false;
  void clashGroupLibrary.put(workspace.id, workspace);
  return true;
}
