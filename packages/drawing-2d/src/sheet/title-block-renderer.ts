/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Title Block Renderer - Generates SVG for drawing title blocks
 *
 * Renders:
 * - Title block border and grid
 * - Field labels and values
 * - Company logo
 * - Revision history table
 */

import type { TitleBlockConfig, RevisionEntry, TitleBlockPosition } from './title-block-types.js';
import type { ScaleBarConfig, NorthArrowConfig } from './scale-bar-types.js';
import type { DrawingScale } from '../styles.js';

/** Inner bounds of the frame (where title block is positioned) */
export interface FrameInnerBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Options for rendering scale bar and north arrow in title block */
export interface TitleBlockExtras {
  scaleBar?: ScaleBarConfig;
  northArrow?: NorthArrowConfig;
  scale?: DrawingScale;
  /** Effective scale factor (mm per meter) - used for scale bar when drawing is dynamically scaled */
  effectiveScaleFactor?: number;
}

/** Result of title block rendering */
export interface TitleBlockRenderResult {
  /** SVG elements for the title block */
  svgElements: string;
  /** Bounds of the title block (mm from paper origin) */
  bounds: { x: number; y: number; width: number; height: number };
}

/**
 * Render a title block to SVG
 */
export function renderTitleBlock(
  config: TitleBlockConfig,
  frameInnerBounds: FrameInnerBounds,
  revisions: RevisionEntry[] = [],
  extras?: TitleBlockExtras
): TitleBlockRenderResult {
  // Calculate title block position and size
  let x: number, y: number, w: number, h: number;

  switch (config.position) {
    case 'bottom-right':
      w = config.widthMm;
      h = config.heightMm;
      x = frameInnerBounds.x + frameInnerBounds.width - w;
      y = frameInnerBounds.y + frameInnerBounds.height - h;
      break;
    case 'bottom-full':
      w = frameInnerBounds.width;
      h = config.heightMm;
      x = frameInnerBounds.x;
      y = frameInnerBounds.y + frameInnerBounds.height - h;
      break;
    case 'right-strip':
      w = config.widthMm;
      h = frameInnerBounds.height;
      x = frameInnerBounds.x + frameInnerBounds.width - w;
      y = frameInnerBounds.y;
      break;
    default:
      w = config.widthMm;
      h = config.heightMm;
      x = frameInnerBounds.x + frameInnerBounds.width - w;
      y = frameInnerBounds.y + frameInnerBounds.height - h;
  }

  let svg = '  <g id="title-block">\n';

  // Background (if specified)
  if (config.backgroundColor) {
    svg += `    <rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" `;
    svg += `width="${w.toFixed(2)}" height="${h.toFixed(2)}" `;
    svg += `fill="${config.backgroundColor}"/>\n`;
  }

  // Outer border
  svg += `    <rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" `;
  svg += `width="${w.toFixed(2)}" height="${h.toFixed(2)}" `;
  svg += `fill="none" stroke="#000000" stroke-width="${config.borderWeight}"/>\n`;

  // Render fields based on layout
  svg += renderTitleBlockFields(config, x, y, w, h);

  // Logo
  if (config.logo?.source) {
    svg += renderLogo(config.logo, x, y, w, h);
  }

  // Scale bar (in title block, bottom-left area)
  if (extras?.scaleBar?.visible && extras?.scale && h > 10) {
    svg += renderScaleBarInTitleBlock(extras.scaleBar, extras.scale, x, y, w, h, config.logo != null, extras.effectiveScaleFactor);
  }

  // North arrow (in title block, next to scale bar or logo area)
  if (extras?.northArrow && extras.northArrow.style !== 'none' && h > 15) {
    svg += renderNorthArrowInTitleBlock(extras.northArrow, x, y, w, h, config.logo != null, config.position);
  }

  // Revision history
  if (config.showRevisionHistory && revisions.length > 0) {
    svg += renderRevisionHistory(
      revisions.slice(0, config.maxRevisionEntries),
      x,
      y,
      w,
      h,
      config
    );
  }

  svg += '  </g>\n';

  return {
    svgElements: svg,
    bounds: { x, y, width: w, height: h },
  };
}

/**
 * Render title block fields in a grid layout
 * Uses a simpler row-based layout with fixed heights based on font size
 */
function renderTitleBlockFields(
  config: TitleBlockConfig,
  x: number,
  y: number,
  w: number,
  h: number
): string {
  let svg = '    <g id="title-block-fields">\n';

  // Calculate grid dimensions
  const numCols = 2;
  const logoSpace = config.logo ? 50 : 0; // Reserve space for logo
  const revisionSpace = config.showRevisionHistory ? 20 : 0;
  const availableWidth = w - logoSpace - 5; // 5mm padding
  const availableHeight = h - revisionSpace - 4; // padding

  // Group fields by row and calculate row heights based on content
  const fieldsByRow = new Map<number, typeof config.fields>();
  for (const field of config.fields) {
    const row = field.row ?? 0;
    if (!fieldsByRow.has(row)) {
      fieldsByRow.set(row, []);
    }
    fieldsByRow.get(row)!.push(field);
  }

  // Calculate minimum height needed for each row based on its largest font
  const rowCount = Math.max(...Array.from(fieldsByRow.keys())) + 1;
  const rowHeights: number[] = [];
  let totalMinHeight = 0;

  for (let r = 0; r < rowCount; r++) {
    const fields = fieldsByRow.get(r) || [];
    // Row needs space for: label (small) + gap + value (fontSize) + padding
    const maxFontSize = fields.length > 0 ? Math.max(...fields.map(f => f.fontSize)) : 3;
    const labelSize = Math.min(maxFontSize * 0.5, 2.2);
    // Minimum row height: label + small gap + value + padding
    const minRowHeight = labelSize + 1 + maxFontSize + 2;
    rowHeights.push(minRowHeight);
    totalMinHeight += minRowHeight;
  }

  // Scale row heights if they exceed available space
  const scaleFactor = totalMinHeight > availableHeight ? availableHeight / totalMinHeight : 1;
  const scaledRowHeights = rowHeights.map(h => h * scaleFactor);

  // Grid start position
  const gridStartX = x + logoSpace + 2;
  const gridStartY = y + 2;
  const colWidth = availableWidth / numCols;

  // Calculate row Y positions
  const rowYPositions: number[] = [gridStartY];
  for (let i = 0; i < scaledRowHeights.length - 1; i++) {
    rowYPositions.push(rowYPositions[i] + scaledRowHeights[i]);
  }

  // Draw horizontal grid lines between rows
  for (let i = 1; i < rowCount; i++) {
    const lineY = rowYPositions[i];
    svg += `      <line x1="${gridStartX.toFixed(2)}" y1="${lineY.toFixed(2)}" `;
    svg += `x2="${(gridStartX + availableWidth - 4).toFixed(2)}" y2="${lineY.toFixed(2)}" `;
    svg += `stroke="#000000" stroke-width="${config.gridWeight}"/>\n`;
  }

  // Vertical dividers for rows with multiple columns
  for (const [row, fields] of fieldsByRow) {
    const hasMultipleCols = fields.some(f => (f.colSpan ?? 1) < 2);
    if (hasMultipleCols) {
      const centerX = gridStartX + colWidth;
      const lineY1 = rowYPositions[row];
      const lineY2 = rowYPositions[row] + scaledRowHeights[row];
      svg += `      <line x1="${centerX.toFixed(2)}" y1="${lineY1.toFixed(2)}" `;
      svg += `x2="${centerX.toFixed(2)}" y2="${lineY2.toFixed(2)}" `;
      svg += `stroke="#000000" stroke-width="${config.gridWeight}"/>\n`;
    }
  }

  // Render each field
  for (const [row, fields] of fieldsByRow) {
    const rowY = rowYPositions[row];
    const rowH = scaledRowHeights[row];

    for (const field of fields) {
      const col = field.col ?? 0;
      const colSpan = field.colSpan ?? 1;
      const fieldX = gridStartX + col * colWidth + 1.5;

      // Scale font sizes if row is compressed
      const effectiveScale = scaleFactor < 1 ? scaleFactor : 1;
      const labelFontSize = Math.min(field.fontSize * 0.45, 2.2) * Math.max(effectiveScale, 0.7);
      const valueFontSize = field.fontSize * Math.max(effectiveScale, 0.7);

      // Position label at top of cell
      const labelY = rowY + 0.5 + labelFontSize;
      svg += `      <text x="${fieldX.toFixed(2)}" y="${labelY.toFixed(2)}" `;
      svg += `font-family="Arial, sans-serif" font-size="${labelFontSize.toFixed(2)}" `;
      svg += `fill="#666666">${escapeXml(field.label)}</text>\n`;

      // Position value below label (with small gap)
      const valueY = labelY + 0.8 + valueFontSize * 0.8;
      svg += `      <text x="${fieldX.toFixed(2)}" y="${valueY.toFixed(2)}" `;
      svg += `font-family="Arial, sans-serif" font-size="${valueFontSize.toFixed(2)}" `;
      svg += `font-weight="${field.fontWeight}" fill="#000000">${escapeXml(field.value)}</text>\n`;
    }
  }

  svg += '    </g>\n';
  return svg;
}

/**
 * Render company logo
 */
function renderLogo(
  logo: NonNullable<TitleBlockConfig['logo']>,
  x: number,
  y: number,
  w: number,
  h: number
): string {
  let svg = '    <g id="title-block-logo">\n';

  let logoX: number, logoY: number;

  switch (logo.position) {
    case 'top-left':
      logoX = x + 3;
      logoY = y + 3;
      break;
    case 'top-right':
      logoX = x + w - logo.widthMm - 3;
      logoY = y + 3;
      break;
    case 'bottom-left':
    default:
      logoX = x + 3;
      logoY = y + h - logo.heightMm - 3;
      break;
  }

  // Render logo as image
  svg += `      <image x="${logoX.toFixed(2)}" y="${logoY.toFixed(2)}" `;
  svg += `width="${logo.widthMm.toFixed(2)}" height="${logo.heightMm.toFixed(2)}" `;
  svg += `href="${escapeXml(logo.source)}" preserveAspectRatio="xMidYMid meet"/>\n`;

  svg += '    </g>\n';
  return svg;
}

/**
 * Render revision history table
 */
function renderRevisionHistory(
  revisions: RevisionEntry[],
  x: number,
  y: number,
  w: number,
  h: number,
  config: TitleBlockConfig
): string {
  let svg = '    <g id="revision-history">\n';

  const tableHeight = 18;
  const tableY = y - tableHeight - 2;
  const rowHeight = 4;
  const fontSize = 2.2;

  // Table header
  svg += `      <rect x="${x.toFixed(2)}" y="${tableY.toFixed(2)}" `;
  svg += `width="${w.toFixed(2)}" height="${tableHeight.toFixed(2)}" `;
  svg += `fill="none" stroke="#000000" stroke-width="${config.gridWeight}"/>\n`;

  // Column headers
  const cols = [
    { label: 'REV', width: w * 0.1 },
    { label: 'DESCRIPTION', width: w * 0.5 },
    { label: 'DATE', width: w * 0.2 },
    { label: 'BY', width: w * 0.2 },
  ];

  let colX = x;
  for (const col of cols) {
    // Header text
    svg += `      <text x="${(colX + 1).toFixed(2)}" y="${(tableY + 3).toFixed(2)}" `;
    svg += `font-family="Arial, sans-serif" font-size="${fontSize}" `;
    svg += `font-weight="bold" fill="#000000">${col.label}</text>\n`;

    // Vertical divider
    if (colX > x) {
      svg += `      <line x1="${colX.toFixed(2)}" y1="${tableY.toFixed(2)}" `;
      svg += `x2="${colX.toFixed(2)}" y2="${(tableY + tableHeight).toFixed(2)}" `;
      svg += `stroke="#000000" stroke-width="${config.gridWeight}"/>\n`;
    }

    colX += col.width;
  }

  // Header divider line
  svg += `      <line x1="${x.toFixed(2)}" y1="${(tableY + rowHeight).toFixed(2)}" `;
  svg += `x2="${(x + w).toFixed(2)}" y2="${(tableY + rowHeight).toFixed(2)}" `;
  svg += `stroke="#000000" stroke-width="${config.gridWeight}"/>\n`;

  // Revision entries
  for (let i = 0; i < revisions.length && i < config.maxRevisionEntries; i++) {
    const rev = revisions[i];
    const rowY = tableY + rowHeight * (i + 1.5);

    colX = x;
    const values = [rev.revision, rev.description, rev.date, rev.author];

    for (let j = 0; j < cols.length; j++) {
      const maxChars = Math.floor(cols[j].width / 2);
      const displayValue =
        values[j].length > maxChars
          ? values[j].substring(0, maxChars - 2) + '..'
          : values[j];

      svg += `      <text x="${(colX + 1).toFixed(2)}" y="${rowY.toFixed(2)}" `;
      svg += `font-family="Arial, sans-serif" font-size="${fontSize}" `;
      svg += `fill="#000000">${escapeXml(displayValue)}</text>\n`;

      colX += cols[j].width;
    }

    // Row divider
    if (i < revisions.length - 1) {
      svg += `      <line x1="${x.toFixed(2)}" y1="${(tableY + rowHeight * (i + 2)).toFixed(2)}" `;
      svg += `x2="${(x + w).toFixed(2)}" y2="${(tableY + rowHeight * (i + 2)).toFixed(2)}" `;
      svg += `stroke="#000000" stroke-width="${config.gridWeight * 0.5}"/>\n`;
    }
  }

  svg += '    </g>\n';
  return svg;
}

/**
 * Render scale bar at BOTTOM LEFT of title block
 */
function renderScaleBarInTitleBlock(
  scaleBar: ScaleBarConfig,
  scale: DrawingScale,
  x: number,
  y: number,
  w: number,
  h: number,
  _hasLogo: boolean,
  effectiveScaleFactor?: number
): string {
  let svg = '    <g id="title-block-scale-bar">\n';

  // Use effective scale factor if provided (for dynamic scaling), otherwise use configured scale
  const scaleFactor = effectiveScaleFactor ?? scale.factor;

  // Position: bottom left with small margin
  const barX = x + 3;
  const barY = y + h - 8; // 8mm from bottom (leaves room for label)
  const maxBarWidth = Math.min(w * 0.3, 50);
  const barLengthMm = (scaleBar.totalLengthM * 1000) / scaleFactor;
  const actualBarLength = Math.min(barLengthMm, maxBarWidth);
  const barHeight = Math.min(scaleBar.heightMm, 3);
  const actualTotalLength = (actualBarLength * scaleFactor) / 1000;

  // Draw alternating bar segments
  const divisions = scaleBar.primaryDivisions;
  const divWidth = actualBarLength / divisions;

  for (let i = 0; i < divisions; i++) {
    const segX = barX + i * divWidth;
    const fill = i % 2 === 0 ? scaleBar.fillColor : '#ffffff';
    svg += `      <rect x="${segX.toFixed(2)}" y="${barY.toFixed(2)}" `;
    svg += `width="${divWidth.toFixed(2)}" height="${barHeight.toFixed(2)}" `;
    svg += `fill="${fill}" stroke="${scaleBar.strokeColor}" stroke-width="${scaleBar.lineWeight}"/>\n`;
  }

  // Draw distance labels - only at 0 and end
  const fontSize = 1.8;
  const labelY = barY + barHeight + fontSize + 0.3;

  svg += `      <text x="${barX.toFixed(2)}" y="${labelY.toFixed(2)}" `;
  svg += `font-family="Arial, sans-serif" font-size="${fontSize}" `;
  svg += `text-anchor="start" fill="#000000">0</text>\n`;

  const endLabel = actualTotalLength < 1
    ? `${(actualTotalLength * 100).toFixed(0)}cm`
    : `${actualTotalLength.toFixed(0)}m`;
  svg += `      <text x="${(barX + actualBarLength).toFixed(2)}" y="${labelY.toFixed(2)}" `;
  svg += `font-family="Arial, sans-serif" font-size="${fontSize}" `;
  svg += `text-anchor="end" fill="#000000">${endLabel}</text>\n`;

  svg += '    </g>\n';
  return svg;
}

/**
 * Render north arrow at BOTTOM RIGHT of title block
 */
function renderNorthArrowInTitleBlock(
  northArrow: NorthArrowConfig,
  x: number,
  y: number,
  w: number,
  h: number,
  _hasLogo: boolean,
  _position: TitleBlockPosition
): string {
  let svg = '    <g id="title-block-north-arrow">\n';

  // Position: bottom right with margin
  const size = Math.min(northArrow.sizeMm, 8, h * 0.6);
  const arrowX = x + w - size - 5; // Right side with margin
  const arrowY = y + h - size / 2 - 3; // Bottom with margin

  // Apply rotation transform
  const rotation = northArrow.rotation;
  svg += `      <g transform="translate(${arrowX.toFixed(2)}, ${arrowY.toFixed(2)}) rotate(${rotation})">\n`;

  // Draw simple north arrow
  const halfSize = size / 2;

  // Arrow body (filled triangle pointing up)
  svg += `        <polygon points="0,${(-halfSize).toFixed(2)} ${(-halfSize / 3).toFixed(2)},${(halfSize / 2).toFixed(2)} ${(halfSize / 3).toFixed(2)},${(halfSize / 2).toFixed(2)}" `;
  svg += `fill="#000000" stroke="none"/>\n`;

  // Arrow outline (lower part, unfilled)
  svg += `        <polygon points="0,${(halfSize / 3).toFixed(2)} ${(-halfSize / 3).toFixed(2)},${(halfSize / 2).toFixed(2)} ${(halfSize / 3).toFixed(2)},${(halfSize / 2).toFixed(2)}" `;
  svg += `fill="#ffffff" stroke="#000000" stroke-width="0.25"/>\n`;

  // "N" label
  const fontSize = size * 0.4;
  svg += `        <text x="0" y="${(-halfSize - 1).toFixed(2)}" `;
  svg += `font-family="Arial, sans-serif" font-size="${fontSize.toFixed(2)}" font-weight="bold" `;
  svg += `text-anchor="middle" fill="#000000">N</text>\n`;

  svg += '      </g>\n';
  svg += '    </g>\n';
  return svg;
}

/**
 * Escape special XML characters
 */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
