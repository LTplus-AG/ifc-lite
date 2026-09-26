/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

type RendererSelection = { selectedId: number | null; selectedIds: Set<number> };
type Color = readonly number[];

/** Keep logical clash selection while its applied amber/cyan paint owns the pixels. */
export function preserveClashPaintInSelection(
  selection: RendererSelection,
  focusedColors: ReadonlyMap<number, Color> | null | undefined,
  appliedColors: ReadonlyMap<number, Color> | null,
): RendererSelection {
  if (!focusedColors?.size || !appliedColors?.size) return selection;

  let selectedIds: Set<number> | null = null;
  let selectedId = selection.selectedId;
  for (const [id, color] of focusedColors) {
    const applied = appliedColors.get(id);
    if (!applied || applied.length !== color.length || !color.every((channel, i) => channel === applied[i])) continue;
    if (selectedId === id) selectedId = null;
    if (selection.selectedIds.has(id)) {
      selectedIds ??= new Set(selection.selectedIds);
      selectedIds.delete(id);
    }
  }
  return selectedIds || selectedId !== selection.selectedId
    ? { selectedId, selectedIds: selectedIds ?? selection.selectedIds }
    : selection;
}
