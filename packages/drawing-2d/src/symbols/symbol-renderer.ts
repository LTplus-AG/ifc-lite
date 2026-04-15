/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Renders architectural symbols to SVG
 */

import type {
  ArchitecturalSymbol,
  DoorSwingParameters,
  SlidingDoorParameters,
  WindowFrameParameters,
  StairArrowParameters,
  Point2D,
} from '../types.js';

/**
 * Renders architectural symbols to SVG elements
 */
export class SymbolRenderer {
  /**
   * Render a symbol to SVG path/group elements
   */
  renderToSVG(symbol: ArchitecturalSymbol, transform?: SVGTransform): string {
    const tx = transform?.offsetX ?? 0;
    const ty = transform?.offsetY ?? 0;
    const scale = transform?.scale ?? 1;
    const flipY = transform?.flipY ?? false;

    const transformAttr = this.buildTransformAttr(symbol, tx, ty, scale, flipY);

    switch (symbol.type) {
      case 'door-swing':
        return this.renderDoorSwing(symbol, transformAttr);
      case 'door-sliding':
        return this.renderDoorSliding(symbol, transformAttr);
      case 'door-folding':
        return this.renderDoorFolding(symbol, transformAttr);
      case 'door-revolving':
        return this.renderDoorRevolving(symbol, transformAttr);
      case 'window-frame':
        return this.renderWindowFrame(symbol, transformAttr);
      case 'stair-arrow':
        return this.renderStairArrow(symbol, transformAttr);
      case 'north-arrow':
        return this.renderNorthArrow(symbol, transformAttr);
      default:
        return '';
    }
  }

  private buildTransformAttr(
    symbol: ArchitecturalSymbol,
    tx: number,
    ty: number,
    scale: number,
    flipY: boolean
  ): string {
    const { position, rotation } = symbol;
    const x = position.x * scale + tx;
    const y = flipY ? -position.y * scale + ty : position.y * scale + ty;
    const rotDeg = (rotation * 180) / Math.PI;

    return `transform="translate(${x}, ${y}) rotate(${flipY ? -rotDeg : rotDeg}) scale(${symbol.scale * scale})"`;
  }

  private renderDoorSwing(symbol: ArchitecturalSymbol, transformAttr: string): string {
    const params = symbol.parameters as DoorSwingParameters;
    const { width, swingAngle, swingDirection, isDouble } = params;

    // Door swing arc
    const arcRadius = width;
    const startAngle = 0;
    const endAngle = swingAngle * swingDirection;

    const startX = 0;
    const startY = arcRadius;
    const endX = Math.sin(endAngle) * arcRadius;
    const endY = Math.cos(endAngle) * arcRadius;

    const largeArc = Math.abs(swingAngle) > Math.PI ? 1 : 0;
    const sweep = swingDirection > 0 ? 1 : 0;

    let svg = `<g ${transformAttr} class="door-swing">`;

    // Swing arc
    svg += `<path d="M ${startX} ${startY} A ${arcRadius} ${arcRadius} 0 ${largeArc} ${sweep} ${endX} ${endY}" `;
    svg += `fill="none" stroke="currentColor" stroke-width="0.5"/>`;

    // Door leaf line (from hinge to arc end)
    svg += `<line x1="0" y1="0" x2="${endX}" y2="${endY}" stroke="currentColor" stroke-width="0.5"/>`;

    if (isDouble) {
      // Mirror for double door
      svg += `<path d="M ${startX} ${-startY} A ${arcRadius} ${arcRadius} 0 ${largeArc} ${1 - sweep} ${endX} ${-endY}" `;
      svg += `fill="none" stroke="currentColor" stroke-width="0.5"/>`;
      svg += `<line x1="0" y1="0" x2="${endX}" y2="${-endY}" stroke="currentColor" stroke-width="0.5"/>`;
    }

    svg += '</g>';
    return svg;
  }

  private renderDoorSliding(symbol: ArchitecturalSymbol, transformAttr: string): string {
    const params = symbol.parameters as SlidingDoorParameters;
    const { width, slideDirection, panelCount } = params;
    const halfWidth = width / 2;

    let svg = `<g ${transformAttr} class="door-sliding">`;

    // Door panel(s)
    if (panelCount === 1) {
      svg += `<line x1="${-halfWidth}" y1="0" x2="${halfWidth}" y2="0" stroke="currentColor" stroke-width="1"/>`;
      // Arrow
      const arrowLen = width * 0.2;
      const arrowX = slideDirection * arrowLen;
      svg += `<path d="M 0 0 L ${arrowX} 0 M ${arrowX * 0.7} ${-arrowLen * 0.3} L ${arrowX} 0 L ${arrowX * 0.7} ${arrowLen * 0.3}" `;
      svg += `fill="none" stroke="currentColor" stroke-width="0.5"/>`;
    } else {
      // Double sliding - two panels meeting in middle
      svg += `<line x1="${-halfWidth}" y1="0" x2="0" y2="0" stroke="currentColor" stroke-width="1"/>`;
      svg += `<line x1="0" y1="0" x2="${halfWidth}" y2="0" stroke="currentColor" stroke-width="1"/>`;
    }

    svg += '</g>';
    return svg;
  }

  private renderDoorFolding(symbol: ArchitecturalSymbol, transformAttr: string): string {
    const params = symbol.parameters as SlidingDoorParameters;
    const { width } = params;

    let svg = `<g ${transformAttr} class="door-folding">`;

    // Zigzag pattern for folding door
    const panelWidth = width / 4;
    const foldDepth = panelWidth * 0.5;

    let path = `M ${-width / 2} 0`;
    for (let i = 0; i < 4; i++) {
      const x = -width / 2 + (i + 1) * panelWidth;
      const y = i % 2 === 0 ? foldDepth : 0;
      path += ` L ${x} ${y}`;
    }

    svg += `<path d="${path}" fill="none" stroke="currentColor" stroke-width="0.5"/>`;
    svg += '</g>';
    return svg;
  }

  private renderDoorRevolving(symbol: ArchitecturalSymbol, transformAttr: string): string {
    const params = symbol.parameters as DoorSwingParameters;
    const radius = params.width / 2;

    let svg = `<g ${transformAttr} class="door-revolving">`;

    // Circle
    svg += `<circle cx="0" cy="0" r="${radius}" fill="none" stroke="currentColor" stroke-width="0.5"/>`;

    // Four door leaves (cross pattern)
    for (let i = 0; i < 4; i++) {
      const angle = (i * Math.PI) / 2;
      const x = Math.cos(angle) * radius;
      const y = Math.sin(angle) * radius;
      svg += `<line x1="0" y1="0" x2="${x}" y2="${y}" stroke="currentColor" stroke-width="0.5"/>`;
    }

    svg += '</g>';
    return svg;
  }

  private renderWindowFrame(symbol: ArchitecturalSymbol, transformAttr: string): string {
    const params = symbol.parameters as WindowFrameParameters;
    const { width, frameDepth } = params;
    const halfWidth = width / 2;

    let svg = `<g ${transformAttr} class="window-frame">`;

    // Frame lines
    svg += `<line x1="${-halfWidth}" y1="${frameDepth}" x2="${halfWidth}" y2="${frameDepth}" stroke="currentColor" stroke-width="0.5"/>`;
    svg += `<line x1="${-halfWidth}" y1="${-frameDepth}" x2="${halfWidth}" y2="${-frameDepth}" stroke="currentColor" stroke-width="0.5"/>`;

    // Glass line (center)
    svg += `<line x1="${-halfWidth}" y1="0" x2="${halfWidth}" y2="0" stroke="currentColor" stroke-width="0.25"/>`;

    svg += '</g>';
    return svg;
  }

  private renderStairArrow(symbol: ArchitecturalSymbol, transformAttr: string): string {
    const params = symbol.parameters as StairArrowParameters;
    const { direction, length } = params;
    const arrowHead = length * 0.15;

    let svg = `<g ${transformAttr} class="stair-arrow">`;

    // Arrow line
    svg += `<line x1="0" y1="0" x2="${length}" y2="0" stroke="currentColor" stroke-width="0.5"/>`;

    // Arrow head
    if (direction === 'up') {
      svg += `<path d="M ${length - arrowHead} ${-arrowHead * 0.5} L ${length} 0 L ${length - arrowHead} ${arrowHead * 0.5}" `;
      svg += `fill="none" stroke="currentColor" stroke-width="0.5"/>`;
    } else {
      svg += `<path d="M ${arrowHead} ${-arrowHead * 0.5} L 0 0 L ${arrowHead} ${arrowHead * 0.5}" `;
      svg += `fill="none" stroke="currentColor" stroke-width="0.5"/>`;
    }

    // Direction text
    const text = direction === 'up' ? 'UP' : 'DN';
    svg += `<text x="${length / 2}" y="${arrowHead * 2}" text-anchor="middle" font-size="3" fill="currentColor">${text}</text>`;

    svg += '</g>';
    return svg;
  }

  private renderNorthArrow(symbol: ArchitecturalSymbol, transformAttr: string): string {
    const scale = symbol.scale * 10; // Base size

    let svg = `<g ${transformAttr} class="north-arrow">`;

    // Arrow
    svg += `<path d="M 0 ${-scale} L ${scale * 0.3} ${scale * 0.5} L 0 ${scale * 0.2} L ${-scale * 0.3} ${scale * 0.5} Z" `;
    svg += `fill="currentColor" stroke="currentColor" stroke-width="0.5"/>`;

    // N label
    svg += `<text x="0" y="${scale * 0.9}" text-anchor="middle" font-size="4" fill="currentColor">N</text>`;

    svg += '</g>';
    return svg;
  }
}

interface SVGTransform {
  offsetX: number;
  offsetY: number;
  scale: number;
  flipY: boolean;
}
