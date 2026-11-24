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

import { escapeXml, svgNum } from '../xml-escape.js';
import type { TitleBlockConfig, RevisionEntry, TitleBlockPosition } from './title-block-types.js';
import { NICE_BAR_LENGTHS_M, barLabelIsExact, formatBarLabel, MIN_BAR_SEGMENT_MM } from './scale-bar-types.js';
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
    svg += `    <rect x="${svgNum(x, 2)}" y="${svgNum(y, 2)}" `;
    svg += `width="${svgNum(w, 2)}" height="${svgNum(h, 2)}" `;
    svg += `fill="${escapeXml(config.backgroundColor)}"/>\n`;
  }

  // Outer border
  svg += `    <rect x="${svgNum(x, 2)}" y="${svgNum(y, 2)}" `;
  svg += `width="${svgNum(w, 2)}" height="${svgNum(h, 2)}" `;
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
    svg += `      <line x1="${svgNum(gridStartX, 2)}" y1="${svgNum(lineY, 2)}" `;
    svg += `x2="${svgNum(gridStartX + availableWidth - 4, 2)}" y2="${svgNum(lineY, 2)}" `;
    svg += `stroke="#000000" stroke-width="${config.gridWeight}"/>\n`;
  }

  // Vertical dividers for rows with multiple columns
  for (const [row, fields] of fieldsByRow) {
    const hasMultipleCols = fields.some(f => (f.colSpan ?? 1) < 2);
    if (hasMultipleCols) {
      const centerX = gridStartX + colWidth;
      const lineY1 = rowYPositions[row];
      const lineY2 = rowYPositions[row] + scaledRowHeights[row];
      svg += `      <line x1="${svgNum(centerX, 2)}" y1="${svgNum(lineY1, 2)}" `;
      svg += `x2="${svgNum(centerX, 2)}" y2="${svgNum(lineY2, 2)}" `;
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
      svg += `      <text x="${svgNum(fieldX, 2)}" y="${svgNum(labelY, 2)}" `;
      svg += `font-family="Arial, sans-serif" font-size="${svgNum(labelFontSize, 2)}" `;
      svg += `fill="#666666">${escapeXml(field.label)}</text>\n`;

      // Position value below label (with small gap)
      const valueY = labelY + 0.8 + valueFontSize * 0.8;
      svg += `      <text x="${svgNum(fieldX, 2)}" y="${svgNum(valueY, 2)}" `;
      svg += `font-family="Arial, sans-serif" font-size="${svgNum(valueFontSize, 2)}" `;
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
  svg += `      <image x="${svgNum(logoX, 2)}" y="${svgNum(logoY, 2)}" `;
  svg += `width="${svgNum(logo.widthMm, 2)}" height="${svgNum(logo.heightMm, 2)}" `;
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
  svg += `      <rect x="${svgNum(x, 2)}" y="${svgNum(tableY, 2)}" `;
  svg += `width="${svgNum(w, 2)}" height="${svgNum(tableHeight, 2)}" `;
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
    svg += `      <text x="${svgNum(colX + 1, 2)}" y="${svgNum(tableY + 3, 2)}" `;
    svg += `font-family="Arial, sans-serif" font-size="${fontSize}" `;
    svg += `font-weight="bold" fill="#000000">${col.label}</text>\n`;

    // Vertical divider
    if (colX > x) {
      svg += `      <line x1="${svgNum(colX, 2)}" y1="${svgNum(tableY, 2)}" `;
      svg += `x2="${svgNum(colX, 2)}" y2="${svgNum(tableY + tableHeight, 2)}" `;
      svg += `stroke="#000000" stroke-width="${config.gridWeight}"/>\n`;
    }

    colX += col.width;
  }

  // Header divider line
  svg += `      <line x1="${svgNum(x, 2)}" y1="${svgNum(tableY + rowHeight, 2)}" `;
  svg += `x2="${svgNum(x + w, 2)}" y2="${svgNum(tableY + rowHeight, 2)}" `;
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

      svg += `      <text x="${svgNum(colX + 1, 2)}" y="${svgNum(rowY, 2)}" `;
      svg += `font-family="Arial, sans-serif" font-size="${fontSize}" `;
      svg += `fill="#000000">${escapeXml(displayValue)}</text>\n`;

      colX += cols[j].width;
    }

    // Row divider
    if (i < revisions.length - 1) {
      svg += `      <line x1="${svgNum(x, 2)}" y1="${svgNum(tableY + rowHeight * (i + 2), 2)}" `;
      svg += `x2="${svgNum(x + w, 2)}" y2="${svgNum(tableY + rowHeight * (i + 2), 2)}" `;
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

  // These two arguments are in RECIPROCAL units, and this function used to
  // substitute one for the other in a single formula:
  //
  //   effectiveScaleFactor  millimetres per metre  (10 at 1:100)
  //   scale.factor          the N of 1:N           (100 at 1:100)
  //
  // `calculateDrawingTransform` returns the former — `sheet-types.ts` uses it
  // as `drawingWidth * scaleFactor` to get millimetres — its own doc says "mm
  // per meter", and `useDrawingExport` passes it on EVERY export. So the branch
  // the exporter always takes was the wrong one, and every exported bar was
  // labelled wrong at every scale: a 5 m bar read 0.5 m at 1:100, and 0.1 m at
  // 1:500 where 25 m is right. Normalise to one unit so there is one formula.
  const mmPerMetre = effectiveScaleFactor ?? 1000 / scale.factor;

  // Position: bottom left with small margin
  const barX = x + 3;
  const barY = y + h - 8; // 8mm from bottom (leaves room for label)
  const maxBarWidth = Math.min(w * 0.3, 50);
  const barLengthMm = scaleBar.totalLengthM * mmPerMetre;

  // Checked BEFORE the clamp, and the ordering is load-bearing: testing the
  // clamped result loses the infinite case, because `Math.min(Infinity, 50)`
  // is a perfectly finite 50.
  //
  // `mmPerMetre > 0` is checked SEPARATELY and is not redundant with
  // `barLengthMm > 0`. An earlier version claimed one check on the product
  // covered "any combination" of the two operands. It does not: two negatives
  // cancel, so `totalLengthM: -5` with `effectiveScaleFactor: -10` gives
  // `barLengthMm` 50 and passes every clause, after which the labels print
  // NEGATIVE distances on a bar that draws normally. That is worse than the
  // malformed rect this guard was written to stop, because nothing about the
  // output looks wrong. Credit to CodeRabbit for the case and to
  // @bimvoice-01 for relaying it.
  //
  // Deliberately not recording which of the sign checks in this file is
  // load-bearing. Three versions of this paragraph did — "the snap masks
  // this", then "this is load-bearing", then "three things reject it" — and
  // each was a correct measurement made false by the next commit, twice by my
  // own hand within one session and once by a revert. A mutation result is a
  // fact about the whole program, so anything anywhere invalidates it, while
  // it reads like a durable property. The commit message is where such a
  // measurement belongs, pinned to a tree.
  //
  // Without this the bar emitted `<rect width="-10.00">`, invalid SVG dressed
  // as a drawing. Drawing nothing is the honest degradation: a missing scale
  // bar is visibly missing.
  if (
    !(mmPerMetre > 0) ||
    !(barLengthMm > 0) ||
    !Number.isFinite(barLengthMm) ||
    !(maxBarWidth > 0)
  ) {
    return '';
  }

  // Snap to a ROUND distance that fits, rather than clamping to the cell width
  // and rounding the label afterwards. Folding the clamp into the label is not
  // enough on its own: the label prints to 0 dp, so a 120 mm title block (a
  // shipped preset) caps a 5 m bar at 36 mm = 3.6 m and prints "4m" — 11% off
  // on a printed sheet, and up to ~33% for a bar landing near 1.5 m.
  //
  // Choosing the distance first makes the label exact by construction.
  //
  // It does NOT yet make the export agree with the on-screen preview, and an
  // earlier version of this comment claimed it did. Measured over nine common
  // (block width x scale) pairs with the default 5 m bar, six disagree:
  // `Drawing2DCanvas` halves/doubles from the configured length, clamps to the
  // cell, and rounds the label from the clamped value — the same clamp-then-
  // round shape this function just stopped doing, so at a 120 mm block and
  // 1:100 the preview still prints "3m" over a 2.5 m bar while the export
  // prints an exact "2m". Unifying them means moving the preview onto
  // `NICE_BAR_LENGTHS_M` too, which is a viewer change and not this diff.

  // `divisions`, bounded at BOTH ends. The low end stops 0 dividing and 2.5 drawing three
  // segments of width L/2.5 (the loop runs while `i < 2.5`), overflowing the
  // bar by 20%. The high end matters too: 100000 divisions emits an 11.5 MB
  // group of 0.0005 mm rects, and 1e7 is about a gigabyte — it hangs the export
  // rather than drawing a bad bar. Nothing legible needs more than 20.
  const divisions = Number.isFinite(scaleBar.primaryDivisions)
    ? Math.min(20, Math.max(1, Math.floor(scaleBar.primaryDivisions)))
    : 1;

  const requestedM = scaleBar.totalLengthM;
  // Fits the cell AND draws segments that survive `toFixed(2)`. Without the
  // lower bound a bar can be chosen whose segments all print `width="0.00"`
  // under a confident label — a label with no bar, which is the dishonesty
  // this function refuses everywhere else. Reachable at 1:1 on a large model,
  // where the transform gives well under 1 mm per metre.
  const fits = (m: number) =>
    m * mmPerMetre <= maxBarWidth + 1e-9 &&
    (m * mmPerMetre) / divisions >= MIN_BAR_SEGMENT_MM - 1e-12;

  // Keep the requested length when it already fits AND already labels exactly.
  // Snapping unconditionally shrank bars that were fine: a 4 m bar at 1:100 is
  // 40 mm in a 50 mm cell and prints "4m" exactly, and snapping it to the
  // nearest ladder value below halved it to 2 m for no reason.
  let actualTotalLength: number | undefined = fits(requestedM) && barLabelIsExact(requestedM)
    ? requestedM
    : undefined;

  if (actualTotalLength === undefined) {
    // Otherwise take the largest round distance that fits and does not claim
    // more than was asked for.
    const candidates = NICE_BAR_LENGTHS_M.filter((m) => m <= requestedM + 1e-9 && fits(m));
    actualTotalLength = candidates[candidates.length - 1];
  }

  if (actualTotalLength === undefined) {
    // Not even the smallest round distance fits the cell. A missing bar is
    // visibly missing; a bar labelled with a distance it does not span is not.
    return '';
  }
  const actualBarLength = actualTotalLength * mmPerMetre;

  // `heightMm` reaches the emitted `height=` attribute, so it needs the same
  // treatment as the length: NaN printed `height="NaN"` on every rect and
  // `y="NaN"` on both labels, and a negative printed `height="-5.00"`. Guarding
  // one of two attributes that reach the SVG is not guarding.
  const barHeight = Number.isFinite(scaleBar.heightMm)
    ? Math.min(Math.max(scaleBar.heightMm, 0.1), 3)
    : 3;

  // Draw alternating bar segments; `divisions` was normalised above.
  const divWidth = actualBarLength / divisions;

  for (let i = 0; i < divisions; i++) {
    const segX = barX + i * divWidth;
    const fill = i % 2 === 0 ? scaleBar.fillColor : '#ffffff';
    svg += `      <rect x="${svgNum(segX, 2)}" y="${svgNum(barY, 2)}" `;
    svg += `width="${svgNum(divWidth, 2)}" height="${svgNum(barHeight, 2)}" `;
    svg += `fill="${escapeXml(fill)}" stroke="${escapeXml(scaleBar.strokeColor)}" stroke-width="${scaleBar.lineWeight}"/>\n`;
  }

  // Draw distance labels - only at 0 and end
  const fontSize = 1.8;
  const labelY = barY + barHeight + fontSize + 0.3;

  svg += `      <text x="${svgNum(barX, 2)}" y="${svgNum(labelY, 2)}" `;
  svg += `font-family="Arial, sans-serif" font-size="${fontSize}" `;
  svg += `text-anchor="start" fill="#000000">0</text>\n`;

  // Shared with `barLabelIsExact`, which decides whether a length CAN be
  // printed without lying. Those two have to agree, and an inline copy here is
  // exactly how they would stop agreeing.
  const endLabel = formatBarLabel(actualTotalLength);
  svg += `      <text x="${svgNum(barX + actualBarLength, 2)}" y="${svgNum(labelY, 2)}" `;
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
  svg += `      <g transform="translate(${svgNum(arrowX, 2)}, ${svgNum(arrowY, 2)}) rotate(${rotation})">\n`;

  // Draw simple north arrow
  const halfSize = size / 2;

  // Arrow body (filled triangle pointing up)
  svg += `        <polygon points="0,${svgNum(-halfSize, 2)} ${svgNum(-halfSize / 3, 2)},${svgNum(halfSize / 2, 2)} ${svgNum(halfSize / 3, 2)},${svgNum(halfSize / 2, 2)}" `;
  svg += `fill="#000000" stroke="none"/>\n`;

  // Arrow outline (lower part, unfilled)
  svg += `        <polygon points="0,${svgNum(halfSize / 3, 2)} ${svgNum(-halfSize / 3, 2)},${svgNum(halfSize / 2, 2)} ${svgNum(halfSize / 3, 2)},${svgNum(halfSize / 2, 2)}" `;
  svg += `fill="#ffffff" stroke="#000000" stroke-width="0.25"/>\n`;

  // "N" label
  const fontSize = size * 0.4;
  svg += `        <text x="0" y="${svgNum(-halfSize - 1, 2)}" `;
  svg += `font-family="Arial, sans-serif" font-size="${svgNum(fontSize, 2)}" font-weight="bold" `;
  svg += `text-anchor="middle" fill="#000000">N</text>\n`;

  svg += '      </g>\n';
  svg += '    </g>\n';
  return svg;
}

