/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { memo } from 'react';
import type { GridAxisSegment } from '@ifc-lite/create';
import { sX, sY, type Fit } from '@/lib/rooms/plate-geometry';

/** Label radius in CSS pixels; Fit reserves the same space at axis ends. */
export const gridLabelRadius = (AxisTag: string): number => Math.max(12, AxisTag.length * 3 + 4);

/** Actual IfcGridAxis lines and their exact AxisTags, mapped from storey-local
 * metres through the plan's shared Fit. Bubbles stay legible while zooming. */
export const DesignGridLayer = memo(function DesignGridLayer({ axes, fit }: {
  axes: readonly GridAxisSegment[];
  fit: Fit;
}) {
  return (
    <g data-plan-layer="design-grids" className="stroke-overlay-ink-muted" strokeWidth={0.75} pointerEvents="none">
      {axes.map((axis) => {
        const a = [sX(fit, axis.a[0]), sY(fit, axis.a[1])];
        const b = [sX(fit, axis.b[0]), sY(fit, axis.b[1])];
        const radius = gridLabelRadius(axis.AxisTag);
        return (
          <g key={`${axis.gridId}:${axis.axisId}`} data-plan-grid={axis.gridId} data-plan-grid-axis={axis.axisId}>
            <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} strokeDasharray="8 4 2 4" />
            {[a, b].map(([x, y], end) => (
              <g key={end}>
                <circle cx={x} cy={y} r={radius} className="fill-background" />
                <text x={x} y={y} textAnchor="middle" dominantBaseline="middle" fontSize={11} className="fill-overlay-ink stroke-none">{axis.AxisTag}</text>
              </g>
            ))}
          </g>
        );
      })}
    </g>
  );
});
