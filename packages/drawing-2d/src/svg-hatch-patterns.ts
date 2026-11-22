/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { HatchPatternType } from './styles.js';

/** Hatch types filled through a `<pattern>`; solid, glass and none fill without one. */
export type PatternHatchType = Exclude<HatchPatternType, 'solid' | 'glass' | 'none'>;

type PatternBody = (s: number) => { size: number; rotate?: number; body: string };

const pen = (width: number, color = '#000') => `stroke="${color}" stroke-width="${width}"`;

/** One `<pattern id="hatch-<type>">` per type a fill can reference (#10933); `s` is the spacing in paper mm. */
const PATTERN_BODIES: Record<PatternHatchType, PatternBody> = {
  diagonal: (s) => ({ size: s, rotate: 45, body: `<line x1="0" y1="0" x2="0" y2="${s}" ${pen(0.15)}/>` }),
  'cross-hatch': (s) => ({
    size: s,
    body: `<line x1="0" y1="0" x2="${s}" y2="${s}" ${pen(0.1)}/><line x1="${s}" y1="0" x2="0" y2="${s}" ${pen(0.1)}/>`,
  }),
  horizontal: (s) => ({ size: s, body: `<line x1="0" y1="${s / 2}" x2="${s}" y2="${s / 2}" ${pen(0.1)}/>` }),
  vertical: (s) => ({ size: s, body: `<line x1="${s / 2}" y1="0" x2="${s / 2}" y2="${s}" ${pen(0.1)}/>` }),
  concrete: (s) => ({
    size: s * 2,
    body: `<circle cx="${s * 0.3}" cy="${s * 0.3}" r="0.3" fill="#666"/>`
      + `<circle cx="${s * 1.3}" cy="${s * 1.3}" r="0.3" fill="#666"/>`
      + `<circle cx="${s * 0.8}" cy="${s * 1.6}" r="0.2" fill="#888"/>`,
  }),
  steel: (s) => ({ size: s * 0.7, rotate: 45, body: `<line x1="0" y1="0" x2="0" y2="${s * 0.7}" ${pen(0.2, '#333')}/>` }),
  brick: (s) => ({ size: s * 0.5, rotate: 45, body: `<line x1="0" y1="0" x2="0" y2="${s * 0.5}" ${pen(0.15)}/>` }),
  insulation: (s) => ({
    size: s,
    body: `<polyline points="0,${s / 2} ${s / 4},0 ${(3 * s) / 4},${s} ${s},${s / 2}" fill="none" ${pen(0.1)}/>`,
  }),
  wood: (s) => ({ size: s * 0.7, rotate: 135, body: `<line x1="0" y1="0" x2="0" y2="${s * 0.7}" ${pen(0.1)}/>` }),
  earth: (s) => ({ size: s, rotate: 45, body: `<line x1="0" y1="0" x2="0" y2="${s / 2}" ${pen(0.15, '#555')}/>` }),
};

/** `<pattern>` definitions for every pattern hatch type, spaced for `scaleFactor`. */
export function createHatchPatternDefs(scaleFactor: number): string {
  const spacing = 3 * (scaleFactor / 100);
  let defs = '';
  for (const [type, make] of Object.entries(PATTERN_BODIES)) {
    const { size, rotate, body } = make(spacing);
    const transform = rotate === undefined ? '' : ` patternTransform="rotate(${rotate})"`;
    defs += `    <pattern id="hatch-${type}" patternUnits="userSpaceOnUse" width="${size}" height="${size}"${transform}>${body}</pattern>\n`;
  }
  return defs;
}
