/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Scale Bar Renderer - Generates SVG for scale bars and north arrows
 *
 * Renders:
 * - Alternating or linear scale bars
 * - Division labels
 * - Unit labels
 * - North arrow symbols
 */

import type { ScaleBarConfig, NorthArrowConfig } from './scale-bar-types.js';
import type { DrawingScale } from '../styles.js';

/** Position in paper coordinates (mm) */
export interface PositionMm {
  x: number;
  y: number;
}

/**
 * Render a scale bar to SVG
 *
 * @param config - Scale bar configuration
 * @param scale - Drawing scale
 * @param positionMm - Position in paper coordinates (mm)
 */
export function renderScaleBar(
  config: ScaleBarConfig,
  scale: DrawingScale,
  positionMm: PositionMm
): string {
  if (!config.visible) return '';

  let svg = '  <g id="scale-bar">\n';

  // Calculate bar dimensions on paper
  // totalLengthM is in model units (meters)
  // At 1:100 scale, 1 meter = 10mm on paper
  const paperScale = 1000 / scale.factor;
  const barLengthMm = config.totalLengthM * paperScale;
  const divisionLengthMm = barLengthMm / config.primaryDivisions;

  const x = positionMm.x;
  const y = positionMm.y;

  switch (config.style) {
    case 'alternating':
      svg += renderAlternatingBar(config, x, y, barLengthMm, divisionLengthMm);
      break;
    case 'linear':
      svg += renderLinearBar(config, x, y, barLengthMm, divisionLengthMm);
      break;
    case 'single':
      svg += renderSingleBar(config, x, y, barLengthMm);
      break;
    case 'graphic':
      svg += renderGraphicBar(config, x, y, barLengthMm, divisionLengthMm);
      break;
    default:
      svg += renderAlternatingBar(config, x, y, barLengthMm, divisionLengthMm);
  }

  // Labels
  svg += renderScaleBarLabels(config, x, y, barLengthMm, divisionLengthMm);

  svg += '  </g>\n';
  return svg;
}

/**
 * Render alternating black/white bar style
 */
function renderAlternatingBar(
  config: ScaleBarConfig,
  x: number,
  y: number,
  barLengthMm: number,
  divisionLengthMm: number
): string {
  let svg = '';

  // Draw divisions
  for (let i = 0; i < config.primaryDivisions; i++) {
    const divX = x + i * divisionLengthMm;
    const fill = i % 2 === 0 ? config.fillColor : '#FFFFFF';

    svg += `    <rect x="${divX.toFixed(2)}" y="${y.toFixed(2)}" `;
    svg += `width="${divisionLengthMm.toFixed(2)}" height="${config.heightMm.toFixed(2)}" `;
    svg += `fill="${fill}" stroke="${config.strokeColor}" stroke-width="${config.lineWeight}"/>\n`;
  }

  // Subdivisions on first division
  if (config.subdivisions > 1) {
    const subLength = divisionLengthMm / config.subdivisions;
    for (let j = 1; j < config.subdivisions; j++) {
      const subX = x + j * subLength;
      const subFill = j % 2 === 0 ? config.fillColor : '#FFFFFF';

      // Smaller sub-bar above main bar
      svg += `    <rect x="${subX.toFixed(2)}" y="${(y - config.heightMm * 0.5).toFixed(2)}" `;
      svg += `width="${subLength.toFixed(2)}" height="${(config.heightMm * 0.5).toFixed(2)}" `;
      svg += `fill="${subFill}" stroke="${config.strokeColor}" stroke-width="${config.lineWeight * 0.7}"/>\n`;
    }

    // Zero marker sub-bar
    svg += `    <rect x="${x.toFixed(2)}" y="${(y - config.heightMm * 0.5).toFixed(2)}" `;
    svg += `width="${subLength.toFixed(2)}" height="${(config.heightMm * 0.5).toFixed(2)}" `;
    svg += `fill="${config.fillColor}" stroke="${config.strokeColor}" stroke-width="${config.lineWeight * 0.7}"/>\n`;
  }

  return svg;
}

/**
 * Render linear (lines only) bar style
 */
function renderLinearBar(
  config: ScaleBarConfig,
  x: number,
  y: number,
  barLengthMm: number,
  divisionLengthMm: number
): string {
  let svg = '';

  // Main horizontal line
  svg += `    <line x1="${x.toFixed(2)}" y1="${(y + config.heightMm / 2).toFixed(2)}" `;
  svg += `x2="${(x + barLengthMm).toFixed(2)}" y2="${(y + config.heightMm / 2).toFixed(2)}" `;
  svg += `stroke="${config.strokeColor}" stroke-width="${config.lineWeight}"/>\n`;

  // Division ticks
  for (let i = 0; i <= config.primaryDivisions; i++) {
    const tickX = x + i * divisionLengthMm;
    svg += `    <line x1="${tickX.toFixed(2)}" y1="${y.toFixed(2)}" `;
    svg += `x2="${tickX.toFixed(2)}" y2="${(y + config.heightMm).toFixed(2)}" `;
    svg += `stroke="${config.strokeColor}" stroke-width="${config.lineWeight}"/>\n`;
  }

  // Subdivisions
  if (config.subdivisions > 1) {
    const subLength = divisionLengthMm / config.subdivisions;
    for (let j = 1; j < config.subdivisions; j++) {
      const subX = x + j * subLength;
      svg += `    <line x1="${subX.toFixed(2)}" y1="${y.toFixed(2)}" `;
      svg += `x2="${subX.toFixed(2)}" y2="${(y + config.heightMm * 0.6).toFixed(2)}" `;
      svg += `stroke="${config.strokeColor}" stroke-width="${config.lineWeight * 0.7}"/>\n`;
    }
  }

  return svg;
}

/**
 * Render simple single bar style
 */
function renderSingleBar(
  config: ScaleBarConfig,
  x: number,
  y: number,
  barLengthMm: number
): string {
  let svg = '';

  // Single solid bar
  svg += `    <rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" `;
  svg += `width="${barLengthMm.toFixed(2)}" height="${config.heightMm.toFixed(2)}" `;
  svg += `fill="${config.fillColor}" stroke="${config.strokeColor}" stroke-width="${config.lineWeight}"/>\n`;

  // End ticks
  svg += `    <line x1="${x.toFixed(2)}" y1="${(y - 1).toFixed(2)}" `;
  svg += `x2="${x.toFixed(2)}" y2="${(y + config.heightMm + 1).toFixed(2)}" `;
  svg += `stroke="${config.strokeColor}" stroke-width="${config.lineWeight}"/>\n`;

  svg += `    <line x1="${(x + barLengthMm).toFixed(2)}" y1="${(y - 1).toFixed(2)}" `;
  svg += `x2="${(x + barLengthMm).toFixed(2)}" y2="${(y + config.heightMm + 1).toFixed(2)}" `;
  svg += `stroke="${config.strokeColor}" stroke-width="${config.lineWeight}"/>\n`;

  return svg;
}

/**
 * Render graphic/decorative bar style
 */
function renderGraphicBar(
  config: ScaleBarConfig,
  x: number,
  y: number,
  barLengthMm: number,
  divisionLengthMm: number
): string {
  let svg = '';

  // Outer frame
  svg += `    <rect x="${(x - 0.5).toFixed(2)}" y="${(y - 0.5).toFixed(2)}" `;
  svg += `width="${(barLengthMm + 1).toFixed(2)}" height="${(config.heightMm + 1).toFixed(2)}" `;
  svg += `fill="none" stroke="${config.strokeColor}" stroke-width="${config.lineWeight}"/>\n`;

  // Alternating triangular pattern
  for (let i = 0; i < config.primaryDivisions; i++) {
    const divX = x + i * divisionLengthMm;

    if (i % 2 === 0) {
      // Solid fill
      svg += `    <rect x="${divX.toFixed(2)}" y="${y.toFixed(2)}" `;
      svg += `width="${divisionLengthMm.toFixed(2)}" height="${config.heightMm.toFixed(2)}" `;
      svg += `fill="${config.fillColor}"/>\n`;
    } else {
      // Diagonal hatch pattern
      svg += `    <rect x="${divX.toFixed(2)}" y="${y.toFixed(2)}" `;
      svg += `width="${divisionLengthMm.toFixed(2)}" height="${config.heightMm.toFixed(2)}" `;
      svg += `fill="#FFFFFF" stroke="${config.strokeColor}" stroke-width="${config.lineWeight * 0.5}"/>\n`;

      // Diagonal lines
      const numLines = 3;
      for (let l = 0; l < numLines; l++) {
        const lineOffset = (divisionLengthMm / numLines) * (l + 0.5);
        svg += `    <line x1="${(divX + lineOffset).toFixed(2)}" y1="${y.toFixed(2)}" `;
        svg += `x2="${(divX + lineOffset - config.heightMm).toFixed(2)}" y2="${(y + config.heightMm).toFixed(2)}" `;
        svg += `stroke="${config.strokeColor}" stroke-width="${config.lineWeight * 0.3}"/>\n`;
      }
    }
  }

  return svg;
}

/**
 * Render scale bar labels
 */
function renderScaleBarLabels(
  config: ScaleBarConfig,
  x: number,
  y: number,
  barLengthMm: number,
  divisionLengthMm: number
): string {
  let svg = '';
  const labelY = y + config.heightMm + config.labelFontSize + 1;

  // Zero label
  svg += `    <text x="${x.toFixed(2)}" y="${labelY.toFixed(2)}" `;
  svg += `font-family="Arial, sans-serif" font-size="${config.labelFontSize}" `;
  svg += `text-anchor="middle" fill="#000000">0</text>\n`;

  // Division labels (only show first, middle, and last to avoid clutter)
  const labelsToShow = [config.primaryDivisions];
  if (config.primaryDivisions > 2) {
    labelsToShow.unshift(Math.floor(config.primaryDivisions / 2));
  }

  const divisionValue = config.totalLengthM / config.primaryDivisions;

  for (const i of labelsToShow) {
    const labelX = x + i * divisionLengthMm;
    const numValue = divisionValue * i;
    const value = numValue.toFixed(numValue >= 10 ? 0 : 1);

    svg += `    <text x="${labelX.toFixed(2)}" y="${labelY.toFixed(2)}" `;
    svg += `font-family="Arial, sans-serif" font-size="${config.labelFontSize}" `;
    svg += `text-anchor="middle" fill="#000000">${value}</text>\n`;
  }

  // Unit label
  if (config.showUnitLabel) {
    const unitLabel = config.units === 'imperial' ? 'ft' : 'm';
    svg += `    <text x="${(x + barLengthMm + config.labelFontSize).toFixed(2)}" y="${labelY.toFixed(2)}" `;
    svg += `font-family="Arial, sans-serif" font-size="${config.labelFontSize}" `;
    svg += `fill="#000000">${unitLabel}</text>\n`;
  }

  return svg;
}

/**
 * Render a north arrow to SVG
 */
export function renderNorthArrow(
  config: NorthArrowConfig,
  positionMm: PositionMm
): string {
  if (config.style === 'none') return '';

  let svg = '  <g id="north-arrow">\n';
  svg += `    <g transform="translate(${positionMm.x.toFixed(2)}, ${positionMm.y.toFixed(2)}) rotate(${config.rotation})">\n`;

  const size = config.sizeMm;
  const halfSize = size / 2;

  switch (config.style) {
    case 'simple':
      svg += renderSimpleNorthArrow(halfSize);
      break;
    case 'compass':
      svg += renderCompassNorthArrow(halfSize);
      break;
    case 'decorative':
      svg += renderDecorativeNorthArrow(halfSize);
      break;
    default:
      svg += renderSimpleNorthArrow(halfSize);
  }

  svg += '    </g>\n';
  svg += '  </g>\n';
  return svg;
}

/**
 * Simple arrow style
 */
function renderSimpleNorthArrow(halfSize: number): string {
  let svg = '';

  // Arrow body (triangle pointing up)
  svg += `      <polygon points="0,${-halfSize} ${halfSize * 0.4},${halfSize * 0.6} ${-halfSize * 0.4},${halfSize * 0.6}" `;
  svg += `fill="#000000" stroke="#000000" stroke-width="0.3"/>\n`;

  // "N" label
  svg += `      <text x="0" y="${(-halfSize - 2).toFixed(2)}" `;
  svg += `font-family="Arial, sans-serif" font-size="${(halfSize * 0.5).toFixed(2)}" `;
  svg += `text-anchor="middle" font-weight="bold" fill="#000000">N</text>\n`;

  return svg;
}

/**
 * Compass rose style
 */
function renderCompassNorthArrow(halfSize: number): string {
  let svg = '';

  // Circle
  svg += `      <circle cx="0" cy="0" r="${halfSize.toFixed(2)}" `;
  svg += `fill="none" stroke="#000000" stroke-width="0.3"/>\n`;

  // North pointer (filled triangle)
  svg += `      <polygon points="0,${-halfSize * 0.9} ${halfSize * 0.2},0 ${-halfSize * 0.2},0" `;
  svg += `fill="#000000"/>\n`;

  // South pointer (outline only)
  svg += `      <polygon points="0,${halfSize * 0.9} ${halfSize * 0.2},0 ${-halfSize * 0.2},0" `;
  svg += `fill="none" stroke="#000000" stroke-width="0.3"/>\n`;

  // East/West points
  svg += `      <line x1="${halfSize * 0.5}" y1="0" x2="${halfSize * 0.9}" y2="0" `;
  svg += `stroke="#000000" stroke-width="0.3"/>\n`;
  svg += `      <line x1="${-halfSize * 0.5}" y1="0" x2="${-halfSize * 0.9}" y2="0" `;
  svg += `stroke="#000000" stroke-width="0.3"/>\n`;

  // "N" label
  svg += `      <text x="0" y="${(-halfSize - 2).toFixed(2)}" `;
  svg += `font-family="Arial, sans-serif" font-size="${(halfSize * 0.4).toFixed(2)}" `;
  svg += `text-anchor="middle" font-weight="bold" fill="#000000">N</text>\n`;

  return svg;
}

/**
 * Decorative/ornate style
 */
function renderDecorativeNorthArrow(halfSize: number): string {
  let svg = '';

  // Outer circle
  svg += `      <circle cx="0" cy="0" r="${halfSize.toFixed(2)}" `;
  svg += `fill="none" stroke="#000000" stroke-width="0.4"/>\n`;

  // Inner circle
  svg += `      <circle cx="0" cy="0" r="${(halfSize * 0.3).toFixed(2)}" `;
  svg += `fill="#000000"/>\n`;

  // Four-pointed star
  const pts = [
    `0,${-halfSize * 0.95}`,
    `${halfSize * 0.15},${-halfSize * 0.15}`,
    `${halfSize * 0.95},0`,
    `${halfSize * 0.15},${halfSize * 0.15}`,
    `0,${halfSize * 0.95}`,
    `${-halfSize * 0.15},${halfSize * 0.15}`,
    `${-halfSize * 0.95},0`,
    `${-halfSize * 0.15},${-halfSize * 0.15}`,
  ].join(' ');

  svg += `      <polygon points="${pts}" fill="none" stroke="#000000" stroke-width="0.3"/>\n`;

  // North half filled
  svg += `      <polygon points="0,${-halfSize * 0.95} ${halfSize * 0.15},${-halfSize * 0.15} 0,0 ${-halfSize * 0.15},${-halfSize * 0.15}" `;
  svg += `fill="#000000"/>\n`;

  // "N" label
  svg += `      <text x="0" y="${(-halfSize - 2).toFixed(2)}" `;
  svg += `font-family="Arial, sans-serif" font-size="${(halfSize * 0.35).toFixed(2)}" `;
  svg += `text-anchor="middle" font-weight="bold" fill="#000000">N</text>\n`;

  return svg;
}
