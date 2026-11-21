/* SPDX-License-Identifier: MPL-2.0 */

import { toStepReal } from './step-serialization.js';
import { parseStepNumber } from './step-slot-grammar.js';

/** Expand the STEP decimal without rounding it. */
export function decimalSeconds(token: string): string | null {
  if (!Number.isFinite(parseStepNumber(token))) return null;
  const m = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(token);
  if (!m) return null;
  const [, sign, integer, fraction = '', power = '0'] = m;
  const exponent = Number(power);
  if (Math.abs(exponent) > 324) return null;
  const digits = integer + fraction;
  const point = integer.length + exponent;
  const whole = point <= 0 ? '0' : digits.slice(0, point).padEnd(point, '0');
  const tail = point <= 0 ? '0'.repeat(-point) + digits : digits.slice(point);
  const trimmed = tail.replace(/0+$/, '');
  const decimal = whole.replace(/^0+(?=\d)/, '') + (trimmed ? '.' + trimmed : '');
  return (sign === '-' && decimal !== '0' ? '-' : '') + decimal;
}

export function durationFromSeconds(token: string): string | null {
  const decimal = decimalSeconds(token);
  if (decimal === null) return null;
  return decimal.startsWith('-') ? "'-PT" + decimal.slice(1) + "S'" : "'PT" + decimal + "S'";
}

/** Weeks, days and clock units are fixed in seconds. Calendar years and months need a date. */
export function durationToSeconds(token: string): string | null {
  const m = /^'(-)?P(?:(\d+)W|(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?)'$/.exec(token);
  if (!m || m[0].endsWith("T'") || !m.slice(2).some((part) => part !== undefined)) return null;
  const scales = [604800, 86400, 3600, 60, 1];
  const seconds = m.slice(2).reduce((total, part, index) => total + Number(part ?? 0) * scales[index], 0);
  return Number.isFinite(seconds) ? toStepReal(m[1] ? -seconds : seconds) : null;
}
