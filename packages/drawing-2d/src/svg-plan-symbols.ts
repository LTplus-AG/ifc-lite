/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PlanSymbol } from './symbols/opening-symbols.js';
import { transformPoint, type Transform2D } from './svg-transform.js';
import { escapeXml, svgNum } from './svg-format.js';
import { getLineStyle } from './styles.js';

/** The door and window symbol layer of a plan, empty when it has none (#10932). */
export function createPlanSymbolLayer(symbols: readonly PlanSymbol[], transform: Transform2D): string {
  if (symbols.length === 0) return '';
  const weight = getLineStyle('projection').weight;
  let svg = '  <g id="plan-symbols" inkscape:label="Symbols" inkscape:groupmode="layer" fill="none">\n';
  for (const symbol of symbols) {
    svg += `    <g data-entity-id="${symbol.entityId}" data-ifc-type="${escapeXml(symbol.ifcType)}" data-symbol="${symbol.kind}" stroke="#000000" stroke-width="${weight}" stroke-linecap="round">\n`;
    for (const { start, end } of symbol.lines) {
      const a = transformPoint(start, transform);
      const b = transformPoint(end, transform);
      svg += `      <line x1="${svgNum(a.x)}" y1="${svgNum(a.y)}" x2="${svgNum(b.x)}" y2="${svgNum(b.y)}"/>\n`;
    }
    svg += '    </g>\n';
  }
  return svg + '  </g>\n';
}
