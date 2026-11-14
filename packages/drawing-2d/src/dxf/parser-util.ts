/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Shared low-level DXF group-value readers and the common entity fields. */

import type { DxfEntityCommon, DxfPair } from './types.js';

export function num(value: string): number {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

export function int(value: string): number {
  const n = Number.parseInt(value.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

export function parseCommon(body: DxfPair[]): DxfEntityCommon {
  const common: DxfEntityCommon = {
    layer: '0',
    colorNumber: 256,
    invisible: false,
    extrusionZ: 1,
  };
  for (const { code, value } of body) {
    switch (code) {
      case 8:
        common.layer = value.trim() || '0';
        break;
      case 62:
        common.colorNumber = int(value);
        break;
      case 420:
        common.trueColor = int(value) & 0xffffff;
        break;
      case 6:
        common.linetype = value.trim();
        break;
      case 370: {
        const lw = int(value); // 1/100 mm; negative values are BYLAYER/BYBLOCK/default
        if (lw > 0) common.lineweightMm = lw / 100;
        break;
      }
      case 60:
        common.invisible = int(value) === 1;
        break;
      case 230:
        common.extrusionZ = num(value);
        break;
    }
  }
  return common;
}
