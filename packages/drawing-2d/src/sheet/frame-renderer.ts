/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Frame Renderer - Generates SVG for drawing frames
 *
 * Renders:
 * - Outer and inner border rectangles
 * - Zone reference labels (A-H, 1-8)
 * - Fold marks for large format folding
 * - Trim marks for print cutting
 */

import type { PaperSizeDefinition } from './paper-sizes.js';
import type { DrawingFrame } from './frame-types.js';

/** Result of frame rendering */
export interface FrameRenderResult {
  /** SVG elements for the frame (as string) */
  svgElements: string;
  /** Inner bounds for drawing content (mm from paper origin) */
  innerBounds: { x: number; y: number; width: number; height: number };
}

/**
 * Render a drawing frame to SVG
 */
export function renderFrame(
  paper: PaperSizeDefinition,
  frame: DrawingFrame
): FrameRenderResult {
  let svg = '  <g id="drawing-frame">\n';

  // Calculate outer border position
  const outerX = frame.margins.left + frame.margins.bindingMargin;
  const outerY = frame.margins.top;
  const outerW =
    paper.widthMm -
    frame.margins.left -
    frame.margins.right -
    frame.margins.bindingMargin;
  const outerH = paper.heightMm - frame.margins.top - frame.margins.bottom;

  // Outer border
  svg += `    <rect x="${outerX.toFixed(2)}" y="${outerY.toFixed(2)}" `;
  svg += `width="${outerW.toFixed(2)}" height="${outerH.toFixed(2)}" `;
  svg += `fill="none" stroke="#000000" stroke-width="${frame.border.outerLineWeight}"/>\n`;

  // Inner border (if gap specified)
  let innerX = outerX;
  let innerY = outerY;
  let innerW = outerW;
  let innerH = outerH;

  if (frame.border.borderGap > 0 && frame.border.innerLineWeight > 0) {
    innerX = outerX + frame.border.borderGap;
    innerY = outerY + frame.border.borderGap;
    innerW = outerW - 2 * frame.border.borderGap;
    innerH = outerH - 2 * frame.border.borderGap;

    svg += `    <rect x="${innerX.toFixed(2)}" y="${innerY.toFixed(2)}" `;
    svg += `width="${innerW.toFixed(2)}" height="${innerH.toFixed(2)}" `;
    svg += `fill="none" stroke="#000000" stroke-width="${frame.border.innerLineWeight}"/>\n`;
  }

  // Zone references
  if (frame.showZoneReferences && frame.horizontalZones > 0) {
    svg += renderZoneReferences(
      outerX,
      outerY,
      outerW,
      outerH,
      frame.border.borderGap,
      frame.horizontalZones,
      frame.verticalZones,
      frame.zoneFontSize,
      frame.border.innerLineWeight
    );
  }

  // Fold marks (for A0, A1, A2 sizes)
  if (frame.border.showFoldMarks) {
    svg += renderFoldMarks(paper, outerX, outerY, outerW, outerH);
  }

  // Trim marks
  if (frame.border.showTrimMarks) {
    svg += renderTrimMarks(paper);
  }

  svg += '  </g>\n';

  return {
    svgElements: svg,
    innerBounds: {
      x: innerX,
      y: innerY,
      width: innerW,
      height: innerH,
    },
  };
}

/**
 * Render zone reference labels around the frame
 */
function renderZoneReferences(
  outerX: number,
  outerY: number,
  outerW: number,
  outerH: number,
  borderGap: number,
  horizontalZones: number,
  verticalZones: number,
  fontSize: number,
  lineWeight: number
): string {
  let svg = '    <g id="zone-references">\n';

  const zoneWidth = outerW / horizontalZones;
  const zoneHeight = outerH / verticalZones;

  // Horizontal zone labels (letters A-H at top and bottom)
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (let i = 0; i < horizontalZones; i++) {
    const x = outerX + zoneWidth * (i + 0.5);
    const letter = letters[i % 26];

    // Top label (in the gap area)
    svg += `      <text x="${x.toFixed(2)}" y="${(outerY - borderGap / 2).toFixed(2)}" `;
    svg += `font-family="Arial, sans-serif" font-size="${fontSize}" `;
    svg += `text-anchor="middle" dominant-baseline="middle">${letter}</text>\n`;

    // Bottom label
    svg += `      <text x="${x.toFixed(2)}" y="${(outerY + outerH + borderGap / 2).toFixed(2)}" `;
    svg += `font-family="Arial, sans-serif" font-size="${fontSize}" `;
    svg += `text-anchor="middle" dominant-baseline="middle">${letter}</text>\n`;

    // Vertical tick marks between zones
    if (i > 0) {
      const tickX = outerX + zoneWidth * i;
      // Top tick
      svg += `      <line x1="${tickX.toFixed(2)}" y1="${outerY.toFixed(2)}" `;
      svg += `x2="${tickX.toFixed(2)}" y2="${(outerY - borderGap + 2).toFixed(2)}" `;
      svg += `stroke="#000000" stroke-width="${lineWeight}"/>\n`;
      // Bottom tick
      svg += `      <line x1="${tickX.toFixed(2)}" y1="${(outerY + outerH).toFixed(2)}" `;
      svg += `x2="${tickX.toFixed(2)}" y2="${(outerY + outerH + borderGap - 2).toFixed(2)}" `;
      svg += `stroke="#000000" stroke-width="${lineWeight}"/>\n`;
    }
  }

  // Vertical zone labels (numbers 1-8 at left and right)
  for (let i = 0; i < verticalZones; i++) {
    const y = outerY + zoneHeight * (i + 0.5);
    const number = (i + 1).toString();

    // Left label
    svg += `      <text x="${(outerX - borderGap / 2).toFixed(2)}" y="${y.toFixed(2)}" `;
    svg += `font-family="Arial, sans-serif" font-size="${fontSize}" `;
    svg += `text-anchor="middle" dominant-baseline="middle">${number}</text>\n`;

    // Right label
    svg += `      <text x="${(outerX + outerW + borderGap / 2).toFixed(2)}" y="${y.toFixed(2)}" `;
    svg += `font-family="Arial, sans-serif" font-size="${fontSize}" `;
    svg += `text-anchor="middle" dominant-baseline="middle">${number}</text>\n`;

    // Horizontal tick marks between zones
    if (i > 0) {
      const tickY = outerY + zoneHeight * i;
      // Left tick
      svg += `      <line x1="${outerX.toFixed(2)}" y1="${tickY.toFixed(2)}" `;
      svg += `x2="${(outerX - borderGap + 2).toFixed(2)}" y2="${tickY.toFixed(2)}" `;
      svg += `stroke="#000000" stroke-width="${lineWeight}"/>\n`;
      // Right tick
      svg += `      <line x1="${(outerX + outerW).toFixed(2)}" y1="${tickY.toFixed(2)}" `;
      svg += `x2="${(outerX + outerW + borderGap - 2).toFixed(2)}" y2="${tickY.toFixed(2)}" `;
      svg += `stroke="#000000" stroke-width="${lineWeight}"/>\n`;
    }
  }

  svg += '    </g>\n';
  return svg;
}

/**
 * Render fold marks for large format drawings
 * Based on DIN 824 folding standard for A0/A1 to A4
 */
function renderFoldMarks(
  paper: PaperSizeDefinition,
  outerX: number,
  outerY: number,
  outerW: number,
  outerH: number
): string {
  let svg = '    <g id="fold-marks">\n';

  // Standard A4 folded size: 210mm x 297mm
  const foldWidth = 210;
  const foldHeight = 297;

  const markLength = 5; // Length of fold mark lines
  const lineWeight = 0.25;

  // Horizontal fold lines (for height > 297mm)
  if (paper.heightMm > foldHeight) {
    const numHFolds = Math.ceil(paper.heightMm / foldHeight);
    for (let i = 1; i < numHFolds; i++) {
      const y = i * foldHeight;
      if (y < paper.heightMm - 20) {
        // Small marks at edges
        svg += `      <line x1="0" y1="${y.toFixed(2)}" x2="${markLength.toFixed(2)}" y2="${y.toFixed(2)}" `;
        svg += `stroke="#000000" stroke-width="${lineWeight}"/>\n`;
        svg += `      <line x1="${(paper.widthMm - markLength).toFixed(2)}" y1="${y.toFixed(2)}" `;
        svg += `x2="${paper.widthMm.toFixed(2)}" y2="${y.toFixed(2)}" `;
        svg += `stroke="#000000" stroke-width="${lineWeight}"/>\n`;
      }
    }
  }

  // Vertical fold lines (for width > 210mm)
  if (paper.widthMm > foldWidth) {
    const numVFolds = Math.ceil(paper.widthMm / foldWidth);
    for (let i = 1; i < numVFolds; i++) {
      const x = paper.widthMm - i * foldWidth; // Fold from right
      if (x > 20) {
        svg += `      <line x1="${x.toFixed(2)}" y1="0" x2="${x.toFixed(2)}" y2="${markLength.toFixed(2)}" `;
        svg += `stroke="#000000" stroke-width="${lineWeight}"/>\n`;
        svg += `      <line x1="${x.toFixed(2)}" y1="${(paper.heightMm - markLength).toFixed(2)}" `;
        svg += `x2="${x.toFixed(2)}" y2="${paper.heightMm.toFixed(2)}" `;
        svg += `stroke="#000000" stroke-width="${lineWeight}"/>\n`;
      }
    }
  }

  svg += '    </g>\n';
  return svg;
}

/**
 * Render trim marks at paper corners
 */
function renderTrimMarks(paper: PaperSizeDefinition): string {
  let svg = '    <g id="trim-marks">\n';

  const markLength = 8;
  const offset = 3;
  const lineWeight = 0.15;

  // Top-left corner
  svg += `      <line x1="${offset.toFixed(2)}" y1="0" x2="${offset.toFixed(2)}" y2="${markLength.toFixed(2)}" `;
  svg += `stroke="#000000" stroke-width="${lineWeight}"/>\n`;
  svg += `      <line x1="0" y1="${offset.toFixed(2)}" x2="${markLength.toFixed(2)}" y2="${offset.toFixed(2)}" `;
  svg += `stroke="#000000" stroke-width="${lineWeight}"/>\n`;

  // Top-right corner
  svg += `      <line x1="${(paper.widthMm - offset).toFixed(2)}" y1="0" `;
  svg += `x2="${(paper.widthMm - offset).toFixed(2)}" y2="${markLength.toFixed(2)}" `;
  svg += `stroke="#000000" stroke-width="${lineWeight}"/>\n`;
  svg += `      <line x1="${(paper.widthMm - markLength).toFixed(2)}" y1="${offset.toFixed(2)}" `;
  svg += `x2="${paper.widthMm.toFixed(2)}" y2="${offset.toFixed(2)}" `;
  svg += `stroke="#000000" stroke-width="${lineWeight}"/>\n`;

  // Bottom-left corner
  svg += `      <line x1="${offset.toFixed(2)}" y1="${(paper.heightMm - markLength).toFixed(2)}" `;
  svg += `x2="${offset.toFixed(2)}" y2="${paper.heightMm.toFixed(2)}" `;
  svg += `stroke="#000000" stroke-width="${lineWeight}"/>\n`;
  svg += `      <line x1="0" y1="${(paper.heightMm - offset).toFixed(2)}" `;
  svg += `x2="${markLength.toFixed(2)}" y2="${(paper.heightMm - offset).toFixed(2)}" `;
  svg += `stroke="#000000" stroke-width="${lineWeight}"/>\n`;

  // Bottom-right corner
  svg += `      <line x1="${(paper.widthMm - offset).toFixed(2)}" y1="${(paper.heightMm - markLength).toFixed(2)}" `;
  svg += `x2="${(paper.widthMm - offset).toFixed(2)}" y2="${paper.heightMm.toFixed(2)}" `;
  svg += `stroke="#000000" stroke-width="${lineWeight}"/>\n`;
  svg += `      <line x1="${(paper.widthMm - markLength).toFixed(2)}" y1="${(paper.heightMm - offset).toFixed(2)}" `;
  svg += `x2="${paper.widthMm.toFixed(2)}" y2="${(paper.heightMm - offset).toFixed(2)}" `;
  svg += `stroke="#000000" stroke-width="${lineWeight}"/>\n`;

  svg += '    </g>\n';
  return svg;
}
