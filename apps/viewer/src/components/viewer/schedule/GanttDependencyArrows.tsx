/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GanttDependencyArrows — renders IfcRelSequence links between tasks as
 * orthogonal connectors (FS / SS / FF / SF). Lives as a standalone file
 * so it can be memoized against a stable `sequences` array reference
 * independent of playback-tick re-renders in the parent timeline.
 */

import { memo } from 'react';
import type { ScheduleSequenceInfo } from '@ifc-lite/parser';
import { timeToX } from './schedule-utils';
import { GANTT_ROW_HEIGHT } from './GanttTaskTree';

export interface GanttDependencyArrowsProps {
  sequences: ScheduleSequenceInfo[];
  taskRowIndex: Map<string, number>;
  /** Memoized { start, finish } per task globalId — avoids re-parsing ISO. */
  taskEpochs: Map<string, { start: number | undefined; finish: number | undefined }>;
  rangeStart: number;
  rangeEnd: number;
  pixelWidth: number;
}

export const GanttDependencyArrows = memo(function GanttDependencyArrows({
  sequences,
  taskRowIndex,
  taskEpochs,
  rangeStart,
  rangeEnd,
  pixelWidth,
}: GanttDependencyArrowsProps) {
  return (
    <g opacity={0.45}>
      {sequences.map((seq, i) => {
        const fromEpochs = taskEpochs.get(seq.relatingTaskGlobalId);
        const toEpochs = taskEpochs.get(seq.relatedTaskGlobalId);
        const rowFrom = taskRowIndex.get(seq.relatingTaskGlobalId);
        const rowTo = taskRowIndex.get(seq.relatedTaskGlobalId);
        if (!fromEpochs || !toEpochs || rowFrom === undefined || rowTo === undefined) return null;
        const fromStart = fromEpochs.start;
        const fromFinish = fromEpochs.finish;
        const toStart = toEpochs.start;
        const toFinish = toEpochs.finish;
        if (
          fromStart === undefined || fromFinish === undefined ||
          toStart === undefined || toFinish === undefined
        ) return null;

        let x1 = 0, x2 = 0;
        switch (seq.sequenceType) {
          case 'START_START':
            x1 = timeToX(fromStart, rangeStart, rangeEnd, pixelWidth);
            x2 = timeToX(toStart, rangeStart, rangeEnd, pixelWidth);
            break;
          case 'FINISH_FINISH':
            x1 = timeToX(fromFinish, rangeStart, rangeEnd, pixelWidth);
            x2 = timeToX(toFinish, rangeStart, rangeEnd, pixelWidth);
            break;
          case 'START_FINISH':
            x1 = timeToX(fromStart, rangeStart, rangeEnd, pixelWidth);
            x2 = timeToX(toFinish, rangeStart, rangeEnd, pixelWidth);
            break;
          case 'FINISH_START':
          default:
            x1 = timeToX(fromFinish, rangeStart, rangeEnd, pixelWidth);
            x2 = timeToX(toStart, rangeStart, rangeEnd, pixelWidth);
            break;
        }
        const y1 = rowFrom * GANTT_ROW_HEIGHT + GANTT_ROW_HEIGHT / 2;
        const y2 = rowTo * GANTT_ROW_HEIGHT + GANTT_ROW_HEIGHT / 2;
        const midX = (x1 + x2) / 2;
        return (
          <path
            key={`seq-${i}`}
            d={`M ${x1} ${y1} L ${midX} ${y1} L ${midX} ${y2} L ${x2} ${y2}`}
            fill="none"
            stroke="currentColor"
            strokeWidth={1}
            strokeDasharray="3 2"
            pointerEvents="none"
          />
        );
      })}
    </g>
  );
});
