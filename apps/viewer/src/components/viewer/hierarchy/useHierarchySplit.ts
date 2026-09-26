/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type RefObject } from 'react';

const MIN_RATIO = 0.15;
const MAX_RATIO = 0.85;
const KEY_STEP = 0.05;
const clamp = (ratio: number) => Math.max(MIN_RATIO, Math.min(MAX_RATIO, ratio));

/** Storeys/models divider with equivalent pointer and keyboard resizing (#5823). */
export function useHierarchySplit(containerRef: RefObject<HTMLDivElement | null>) {
  const [splitRatio, setSplitRatio] = useState(0.5);
  const [isDragging, setIsDragging] = useState(false);

  const handleResizeStart = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(true);
  }, []);

  const handleResizeKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const delta = event.key === 'ArrowDown' ? KEY_STEP : event.key === 'ArrowUp' ? -KEY_STEP : 0;
    if (!delta && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    setSplitRatio((ratio) => event.key === 'Home' ? MIN_RATIO : event.key === 'End' ? MAX_RATIO : clamp(ratio + delta));
  }, []);

  useEffect(() => {
    if (!isDragging) return;
    const handleMouseMove = (event: MouseEvent) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const availableHeight = rect.height - 70; // Search header above the split.
      if (availableHeight <= 0) return;
      setSplitRatio(clamp((event.clientY - rect.top - 70) / availableHeight));
    };
    const handleMouseUp = () => setIsDragging(false);
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [containerRef, isDragging]);

  return { splitRatio, isDragging, handleResizeStart, handleResizeKeyDown };
}
