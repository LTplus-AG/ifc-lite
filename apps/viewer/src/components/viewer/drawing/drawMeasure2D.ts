/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Distance tool's lines, labels and snap crosshair on the 2D drawing
 * canvas, in screen space. Moved out of `Drawing2DCanvas.tsx` (held to a
 * module-size budget) unchanged.
 */

import { formatDistance } from '../tools/formatDistance';

type Pt = { x: number; y: number };

export interface MeasureLayer {
  measureMode: boolean;
  measureStart: Pt | null;
  measureCurrent: Pt | null;
  measureResults: readonly { start: Pt; end: Pt; distance: number }[];
  measureSnapPoint: Pt | null;
  sectionAxis: 'down' | 'front' | 'side';
  transform: { x: number; y: number; scale: number };
  unitDisplayOverrides: Record<string, string>;
}

export function drawMeasurements2D(ctx: CanvasRenderingContext2D, layer: MeasureLayer): void {
  const { measureMode, measureStart, measureCurrent, measureResults, measureSnapPoint, sectionAxis, transform, unitDisplayOverrides } = layer;
  const drawMeasureLine = (
    start: { x: number; y: number },
    end: { x: number; y: number },
    distance: number,
    color: string = '#2196F3',
    isActive: boolean = false
  ) => {
    // Convert drawing coords to screen coords with axis-specific transforms
    const measureScaleX = sectionAxis === 'side' ? -transform.scale : transform.scale;
    const measureScaleY = sectionAxis === 'down' ? transform.scale : -transform.scale;
    const screenStart = {
      x: start.x * measureScaleX + transform.x,
      y: start.y * measureScaleY + transform.y,
    };
    const screenEnd = {
      x: end.x * measureScaleX + transform.x,
      y: end.y * measureScaleY + transform.y,
    };

    // Draw line
    ctx.strokeStyle = color;
    ctx.lineWidth = isActive ? 2 : 1.5;
    ctx.setLineDash(isActive ? [6, 3] : []);
    ctx.beginPath();
    ctx.moveTo(screenStart.x, screenStart.y);
    ctx.lineTo(screenEnd.x, screenEnd.y);
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw endpoints
    ctx.fillStyle = color;
    const endpointRadius = isActive ? 5 : 4;
    ctx.beginPath();
    ctx.arc(screenStart.x, screenStart.y, endpointRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(screenEnd.x, screenEnd.y, endpointRadius, 0, Math.PI * 2);
    ctx.fill();

    // Draw distance label
    const midX = (screenStart.x + screenEnd.x) / 2;
    const midY = (screenStart.y + screenEnd.y) / 2;

    // Format distance using shared utility
    const labelText = formatDistance(distance, unitDisplayOverrides);

    // Background for label
    ctx.font = '12px system-ui, sans-serif';
    const textMetrics = ctx.measureText(labelText);
    const padding = 4;
    const bgWidth = textMetrics.width + padding * 2;
    const bgHeight = 18;

    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.fillRect(midX - bgWidth / 2, midY - bgHeight / 2, bgWidth, bgHeight);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.strokeRect(midX - bgWidth / 2, midY - bgHeight / 2, bgWidth, bgHeight);

    // Text
    ctx.fillStyle = '#000000';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(labelText, midX, midY);
  };

  // Draw completed measurements
  for (const result of measureResults) {
    drawMeasureLine(result.start, result.end, result.distance, '#2196F3', false);
  }

  // Draw active measurement
  if (measureStart && measureCurrent) {
    const dx = measureCurrent.x - measureStart.x;
    const dy = measureCurrent.y - measureStart.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    drawMeasureLine(measureStart, measureCurrent, distance, '#FF5722', true);
  }

  // Draw snap indicator
  if (measureMode && measureSnapPoint) {
    // Use axis-specific transforms (matching canvas rendering)
    const snapScaleX = sectionAxis === 'side' ? -transform.scale : transform.scale;
    const snapScaleY = sectionAxis === 'down' ? transform.scale : -transform.scale;
    const screenSnap = {
      x: measureSnapPoint.x * snapScaleX + transform.x,
      y: measureSnapPoint.y * snapScaleY + transform.y,
    };

    // Draw snap crosshair
    ctx.strokeStyle = '#4CAF50';
    ctx.lineWidth = 1.5;
    const snapSize = 12;

    ctx.beginPath();
    ctx.moveTo(screenSnap.x - snapSize, screenSnap.y);
    ctx.lineTo(screenSnap.x + snapSize, screenSnap.y);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(screenSnap.x, screenSnap.y - snapSize);
    ctx.lineTo(screenSnap.x, screenSnap.y + snapSize);
    ctx.stroke();

    // Draw snap circle
    ctx.beginPath();
    ctx.arc(screenSnap.x, screenSnap.y, 6, 0, Math.PI * 2);
    ctx.stroke();
  }
}
