/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The dashboard's card grid: 12 columns, drag by the card's title bar,
 * resize from the corner, positions written back into `DashboardSpec.layout`
 * (the saved JSON) on every drop. react-grid-layout v2 (MIT, StrictMode-safe)
 * with an explicit `layout` prop — the spec is the one source of truth, the
 * grid never owns positions.
 *
 * Cards are rendered through a render prop so the grid knows nothing about
 * charts; a test can pass plain boxes and assert the layout it writes back.
 */
import { useCallback, useMemo, type ReactNode } from 'react';
import { GridLayout, useContainerWidth, type Layout, type LayoutItem } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import type { DashboardLayoutItem } from '@ifc-lite/charts';

export const GRID_COLUMNS = 12;
export const GRID_ROW_HEIGHT = 56;
/** The drag handle selector: a card's title bar carries this class. */
export const GRID_DRAG_HANDLE_CLASS = 'chart-drag-handle';

export interface DashboardGridProps {
  layout: readonly DashboardLayoutItem[];
  /** Ids in render order; an id without a layout item gets appended below. */
  ids: readonly string[];
  renderItem: (id: string) => ReactNode;
  onLayoutChange: (layout: DashboardLayoutItem[]) => void;
}

/** `DashboardLayoutItem` ↔ react-grid-layout's `LayoutItem`. */
export function toGridLayout(layout: readonly DashboardLayoutItem[], ids: readonly string[]): LayoutItem[] {
  const byId = new Map(layout.map((l) => [l.chartId, l]));
  let nextY = layout.reduce((max, l) => Math.max(max, l.y + l.h), 0);
  return ids.map((id) => {
    const item = byId.get(id);
    if (item) return { i: id, x: item.x, y: item.y, w: item.w, h: item.h, minW: 3, minH: 3 };
    const fresh = { i: id, x: 0, y: nextY, w: 6, h: 4, minW: 3, minH: 3 };
    nextY += 4;
    return fresh;
  });
}

export function fromGridLayout(layout: Layout): DashboardLayoutItem[] {
  return layout.map((l) => ({ chartId: l.i, x: l.x, y: l.y, w: l.w, h: l.h }));
}

function sameLayout(a: readonly DashboardLayoutItem[], b: readonly DashboardLayoutItem[]): boolean {
  if (a.length !== b.length) return false;
  const byId = new Map(a.map((l) => [l.chartId, l]));
  return b.every((l) => {
    const m = byId.get(l.chartId);
    return m !== undefined && m.x === l.x && m.y === l.y && m.w === l.w && m.h === l.h;
  });
}

export function DashboardGrid({ layout, ids, renderItem, onLayoutChange }: DashboardGridProps) {
  const { width, containerRef, mounted } = useContainerWidth();
  const gridLayout = useMemo(() => toGridLayout(layout, ids), [layout, ids]);

  const handleChange = useCallback((next: Layout) => {
    const converted = fromGridLayout(next);
    // The grid reports on every render; only a real move/resize is a save.
    if (!sameLayout(layout, converted)) onLayoutChange(converted);
  }, [layout, onLayoutChange]);

  return (
    <div ref={containerRef} className="w-full" data-dashboard-grid>
      {mounted && (
        <GridLayout
          width={width}
          layout={gridLayout}
          gridConfig={{ cols: GRID_COLUMNS, rowHeight: GRID_ROW_HEIGHT, margin: [8, 8], containerPadding: [0, 0] }}
          dragConfig={{ handle: `.${GRID_DRAG_HANDLE_CLASS}`, bounded: true }}
          resizeConfig={{ handles: ['se'] }}
          onLayoutChange={handleChange}
        >
          {ids.map((id) => (
            <div key={id} className="min-h-0 min-w-0" data-grid-item={id}>
              {renderItem(id)}
            </div>
          ))}
        </GridLayout>
      )}
    </div>
  );
}
