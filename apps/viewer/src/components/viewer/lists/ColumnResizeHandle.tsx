/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type React from 'react';
import { useEffect, useRef } from 'react';

interface ColumnResizeHandleProps {
  columnId: string;
  width: number;
  title: string;
  setWidthOverrides: React.Dispatch<React.SetStateAction<Record<string, number>>>;
}
/** A pointer resize grip with equivalent arrow-key resizing and Home reset. */
export function ColumnResizeHandle({ columnId, width, title, setWidthOverrides }: ColumnResizeHandleProps) {
  const cleanupResizeRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanupResizeRef.current?.(), []);

  const startResize = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    cleanupResizeRef.current?.();
    const startX = event.clientX;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    const onMove = (move: MouseEvent) => setWidthOverrides((previous) => ({
      ...previous, [columnId]: Math.max(56, width + move.clientX - startX),
    }));
    const cleanup = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', cleanup);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      cleanupResizeRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', cleanup);
    cleanupResizeRef.current = cleanup;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };
  const resetWidth = () => setWidthOverrides((previous) => {
    const next = { ...previous };
    delete next[columnId];
    return next;
  });

  return (
    <button
      type="button"
      aria-label={title}
      onMouseDown={startResize}
      onDoubleClick={resetWidth}
      onKeyDown={(event) => {
        if (event.key === 'Home') {
          event.preventDefault();
          resetWidth();
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault();
          const delta = event.key === 'ArrowRight' ? 10 : -10;
          setWidthOverrides((previous) => ({ ...previous, [columnId]: Math.max(56, width + delta) }));
        }
      }}
      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-primary/40 focus-visible:bg-primary/40 focus-visible:outline"
      title={title}
    />
  );
}
