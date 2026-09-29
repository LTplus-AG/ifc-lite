/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Selection for the Lists results table (#6368). Every activatable line of the
 * table — a nested-tree group header, a member row, or a schedule (pivot) row —
 * stands for a set of IFC entities: a member row for one, a group for every
 * member under it (sub-group descendants included), a schedule row for the
 * members of its group-value tuple. Clicking one selects that set, exactly as
 * the Hierarchy panel does since #5885, through the shared
 * `useEntityListMultiSelect().selectGroups` so Ctrl/Cmd toggles and Shift
 * extends a range over the on-screen order.
 *
 * One index space per view: `lines[i]` is the entity set of the i-th rendered
 * line, aligned with the virtualizer, so a Shift range between a group header
 * and a member row spans exactly what is between them on screen.
 *
 * Global ids go through `toGlobalIdFromModels`, so a list over a federation
 * highlights each member in its own model's id range.
 */

import { useCallback, useEffect, useMemo } from 'react';
import type { ListRow } from '@ifc-lite/lists';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { useEntityListMultiSelect, type MultiSelectItem, type SelectModifiers } from '@/hooks/useEntityListMultiSelect';

export interface ListRowSelection {
  /** Select line `index`'s entities, honouring Ctrl/Cmd and Shift. */
  activate: (index: number, modifiers: SelectModifiers) => void;
  /** Whether every entity line `index` stands for is selected. */
  isSelected: (index: number) => boolean;
}

/**
 * @param lines the member rows of each rendered line, in on-screen order.
 * @param viewKey changes when the index space is replaced wholesale (nested ↔
 *   schedule), so a Shift+click cannot extend from an anchor in the other view.
 */
export function useListRowSelection(lines: ReadonlyArray<ReadonlyArray<ListRow>>, viewKey: string): ListRowSelection {
  const models = useViewerStore((s) => s.models);
  const selectedEntityIds = useViewerStore((s) => s.selectedEntityIds);
  const selectedEntityId = useViewerStore((s) => s.selectedEntityId);
  const { selectGroups, setAnchor } = useEntityListMultiSelect();

  useEffect(() => { setAnchor(-1); }, [viewKey, setAnchor]);

  // A parent group repeats its descendants' rows, so resolve each row once.
  const groups = useMemo<MultiSelectItem[][]>(() => {
    const byRow = new Map<ListRow, MultiSelectItem>();
    const toItem = (row: ListRow): MultiSelectItem => {
      let item = byRow.get(row);
      if (!item) {
        item = { globalId: toGlobalIdFromModels(models, row.modelId, row.entityId), modelId: row.modelId, expressId: row.entityId };
        byRow.set(row, item);
      }
      return item;
    };
    return lines.map((rows) => rows.map(toItem));
  }, [lines, models]);

  const activate = useCallback((index: number, modifiers: SelectModifiers) => {
    selectGroups(groups, index, modifiers);
  }, [groups, selectGroups]);

  const isSelected = useCallback((index: number) => {
    const members = groups[index];
    if (!members || members.length === 0) return false;
    return members.every((m) => selectedEntityIds.has(m.globalId) || m.globalId === selectedEntityId);
  }, [groups, selectedEntityIds, selectedEntityId]);

  return { activate, isSelected };
}
