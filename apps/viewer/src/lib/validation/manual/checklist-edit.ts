/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure structural edits on a `ChecklistTemplate` (#6401): create, rename,
 * reorder and delete groups and items. Every function returns a NEW
 * template (the store keeps it immutable) and returns the input unchanged
 * when the target does not exist or the move would leave the list, so a
 * stale click is a no-op rather than an error.
 */

import {
  MAX_CHECKLIST_DESCRIPTION,
  MAX_CHECKLIST_GROUPS,
  MAX_CHECKLIST_ITEMS_PER_GROUP,
  MAX_CHECKLIST_TEXT,
  newChecklistId,
  type ChecklistGroup,
  type ChecklistItem,
  type ChecklistTemplate,
} from './checklist.js';

function moveInArray<T>(list: readonly T[], index: number, delta: number): T[] | null {
  const target = index + delta;
  if (index < 0 || target < 0 || target >= list.length || delta === 0) return null;
  const next = [...list];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved);
  return next;
}

function mapGroup(
  template: ChecklistTemplate,
  groupId: string,
  fn: (group: ChecklistGroup) => ChecklistGroup,
): ChecklistTemplate {
  let changed = false;
  const groups = template.groups.map((g) => {
    if (g.id !== groupId) return g;
    const next = fn(g);
    if (next !== g) changed = true;
    return next;
  });
  return changed ? { ...template, groups } : template;
}

export function renameChecklist(template: ChecklistTemplate, name: string): ChecklistTemplate {
  return { ...template, name: name.slice(0, MAX_CHECKLIST_TEXT) };
}

/** Append a group; returns the new template and the created id (null when at the cap). */
export function addGroup(template: ChecklistTemplate, name: string): { template: ChecklistTemplate; id: string | null } {
  if (template.groups.length >= MAX_CHECKLIST_GROUPS) return { template, id: null };
  const id = newChecklistId('group');
  const group: ChecklistGroup = { id, name: name.slice(0, MAX_CHECKLIST_TEXT), items: [] };
  return { template: { ...template, groups: [...template.groups, group] }, id };
}

export function renameGroup(template: ChecklistTemplate, groupId: string, name: string): ChecklistTemplate {
  return mapGroup(template, groupId, (g) => ({ ...g, name: name.slice(0, MAX_CHECKLIST_TEXT) }));
}

export function removeGroup(template: ChecklistTemplate, groupId: string): ChecklistTemplate {
  const groups = template.groups.filter((g) => g.id !== groupId);
  return groups.length === template.groups.length ? template : { ...template, groups };
}

/** Move a group up (`-1`) or down (`+1`). */
export function moveGroup(template: ChecklistTemplate, groupId: string, delta: number): ChecklistTemplate {
  const groups = moveInArray(template.groups, template.groups.findIndex((g) => g.id === groupId), delta);
  return groups ? { ...template, groups } : template;
}

/** Append an item to a group; returns the created id (null when the group is missing or full). */
export function addItem(template: ChecklistTemplate, groupId: string, text: string): { template: ChecklistTemplate; id: string | null } {
  const group = template.groups.find((g) => g.id === groupId);
  if (!group || group.items.length >= MAX_CHECKLIST_ITEMS_PER_GROUP) return { template, id: null };
  const id = newChecklistId('item');
  const item: ChecklistItem = { id, text: text.slice(0, MAX_CHECKLIST_TEXT) };
  return { template: mapGroup(template, groupId, (g) => ({ ...g, items: [...g.items, item] })), id };
}

export function updateItem(
  template: ChecklistTemplate,
  groupId: string,
  itemId: string,
  patch: { text?: string; description?: string },
): ChecklistTemplate {
  return mapGroup(template, groupId, (g) => {
    if (!g.items.some((i) => i.id === itemId)) return g;
    return {
      ...g,
      items: g.items.map((item) => {
        if (item.id !== itemId) return item;
        const next: ChecklistItem = { id: item.id, text: patch.text !== undefined ? patch.text.slice(0, MAX_CHECKLIST_TEXT) : item.text };
        const description = patch.description !== undefined ? patch.description.slice(0, MAX_CHECKLIST_DESCRIPTION) : item.description;
        if (description) next.description = description;
        return next;
      }),
    };
  });
}

export function removeItem(template: ChecklistTemplate, groupId: string, itemId: string): ChecklistTemplate {
  return mapGroup(template, groupId, (g) => {
    const items = g.items.filter((i) => i.id !== itemId);
    return items.length === g.items.length ? g : { ...g, items };
  });
}

/** Move an item up (`-1`) or down (`+1`) within its group. */
export function moveItem(template: ChecklistTemplate, groupId: string, itemId: string, delta: number): ChecklistTemplate {
  return mapGroup(template, groupId, (g) => {
    const items = moveInArray(g.items, g.items.findIndex((i) => i.id === itemId), delta);
    return items ? { ...g, items } : g;
  });
}
