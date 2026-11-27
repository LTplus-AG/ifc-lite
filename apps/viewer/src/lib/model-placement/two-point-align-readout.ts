/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The text of a two-point align's readout (#11505). The on-screen block and the
 * "Copy transformation" clipboard text are the SAME lines, produced once here,
 * so what is copied is what was shown.
 */
import { radiansToDegrees } from './rotation.js';
import { checkNeedsWarning, scaleRatioIsOff, type TwoPointAlignment } from './two-point-align.js';

/** Elevation mismatch of the two segments worth its own line, metres. */
export const DELTA_Z_NOTE_M = 0.01;

/** A translator over the readout's catalogue keys; the component passes `t`. */
export type ReadoutTranslate = (
  key: 'repositionPanel.twoPoint.readoutRotation' | 'repositionPanel.twoPoint.readoutMove'
    | 'repositionPanel.twoPoint.readoutCheckOk' | 'repositionPanel.twoPoint.readoutCheckWarn'
    | 'repositionPanel.twoPoint.readoutRatio' | 'repositionPanel.twoPoint.readoutDeltaZ',
  values: Record<string, string>,
) => string;

export interface AlignReadout {
  lines: readonly string[];
  /** The check line is over the threshold, or the pairs disagree in scale. */
  warn: boolean;
}

function signed(value: number, digits: number): string {
  // "-0.00" is how a tiny negative rounds; show it as the zero it is.
  const text = value.toFixed(digits);
  const zero = Number(text) === 0;
  return zero ? (0).toFixed(digits) : `${value > 0 ? '+' : ''}${text}`;
}

/** Millimetres below a metre ("2 mm", "0.4 mm"), metres above. */
export function formatCheckDistance(metres: number): string {
  if (metres < 1) {
    const mm = metres * 1000;
    return `${mm >= 10 ? mm.toFixed(0) : mm.toFixed(1).replace(/\.0$/, '')} mm`;
  }
  return `${metres.toFixed(3)} m`;
}

export function buildAlignReadout(alignment: TwoPointAlignment, t: ReadoutTranslate): AlignReadout {
  const { check } = alignment;
  const lines = [
    t('repositionPanel.twoPoint.readoutRotation', { degrees: signed(radiansToDegrees(alignment.heading), 2) }),
    t('repositionPanel.twoPoint.readoutMove', {
      dx: alignment.delta[0].toFixed(3), dy: alignment.delta[1].toFixed(3), dz: alignment.delta[2].toFixed(3),
    }),
    t(checkNeedsWarning(check) ? 'repositionPanel.twoPoint.readoutCheckWarn' : 'repositionPanel.twoPoint.readoutCheckOk',
      { distance: formatCheckDistance(check.distance) }),
  ];
  if (scaleRatioIsOff(check)) {
    lines.push(t('repositionPanel.twoPoint.readoutRatio', { ratio: check.planRatio.toFixed(4) }));
  }
  if (Math.abs(check.deltaZ) > DELTA_Z_NOTE_M) {
    lines.push(t('repositionPanel.twoPoint.readoutDeltaZ', { dz: signed(check.deltaZ, 3) }));
  }
  return { lines, warn: checkNeedsWarning(check) || scaleRatioIsOff(check) };
}
