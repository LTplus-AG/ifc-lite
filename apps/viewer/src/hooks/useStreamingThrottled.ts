/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useRef } from 'react';
import { useViewerStore } from '@/store';
import { streamingRefreshDue } from '@/lib/streaming-refresh';

/**
 * `value`, held for up to `STREAMING_PANEL_REFRESH_MS` while geometry is
 * streaming, and passed through unchanged otherwise (#6411).
 *
 * For the inputs of a memo that walks the whole model: during a stream those
 * inputs change on every geometry publish, so the memo reran twice a second
 * over a growing model. Feed the memo the held value instead. The component
 * still subscribes to `geometryStreamingActive`, so the final value lands on
 * the render where streaming ends.
 *
 * Hold only data that is progress while streaming (counts, trees). Pass values
 * that must track the store exactly, like selection or visibility, directly.
 */
export function useStreamingThrottled<T>(value: T): T {
  const streaming = useViewerStore((s) => s.geometryStreamingActive);
  const held = useRef<{ value: T; takenAt: number } | null>(null);
  let current = held.current;
  if (current === null || !streaming || (current.value !== value && streamingRefreshDue(current.takenAt, performance.now()))) {
    current = { value, takenAt: performance.now() };
    held.current = current;
  }
  return current.value;
}
