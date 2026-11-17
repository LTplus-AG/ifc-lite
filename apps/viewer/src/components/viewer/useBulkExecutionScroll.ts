/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useCallback, useEffect, useRef, type RefObject } from 'react';
import type { BulkQueryResult } from '@ifc-lite/mutations';

export function useBulkExecutionScroll(scrollAreaRef: RefObject<HTMLDivElement | null>,
  executeResult: BulkQueryResult | null, executeProgress: { done: number; total: number } | null) {
  const prevProgressRef = useRef<typeof executeProgress>(null);
  // Scroll to bottom — double rAF ensures DOM is painted
  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        scrollAreaRef.current?.scrollTo({
          top: scrollAreaRef.current.scrollHeight,
          behavior: 'smooth',
        });
      });
    });
  }, []);

  // Auto-scroll when execute completes
  useEffect(() => {
    if (executeResult) scrollToBottom();
  }, [executeResult, scrollToBottom]);

  // Auto-scroll when progress first appears
  useEffect(() => {
    if (executeProgress && !prevProgressRef.current) scrollToBottom();
    prevProgressRef.current = executeProgress;
  }, [executeProgress, scrollToBottom]);

}
