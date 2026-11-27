/* SPDX-License-Identifier: MPL-2.0 */

import { toStepReal } from './step-serialization.js';
import { parseStepNumber } from './step-slot-grammar.js';
import { SourceRecords, slotRef, slotUnset, type SourceStore } from './schema-converter-structural-source.js';
import { listItems } from './schema-converter-structural-axes.js';
import { withoutComments } from './step-comment-skip.js';

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
  const m = /^'(-)?P(?:(\d+(?:\.\d+)?)W|(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?)'$/.exec(token);
  if (!m || m[0].endsWith("T'")) return null;
  const fields = m.slice(2);
  const supplied = fields.filter((part) => part !== undefined);
  if (!supplied.length || supplied.slice(0, -1).some((part) => part.includes('.'))) return null;
  const scales = [604800, 86400, 3600, 60, 1];
  const seconds = fields.reduce((total, part, index) => total + Number(part ?? 0) * scales[index], 0);
  return Number.isFinite(seconds) ? toStepReal(m[1] ? -seconds : seconds) : null;
}

export const DURATION_TIME_UNIT_WARNING = 'Work-control duration conversion assumed seconds despite a non-second project TIMEUNIT. The exported duration or total float may have changed (#11192).';

export function hasNonSecondProjectTimeUnit(store: SourceStore): boolean {
  const records = new SourceRecords(store);
  return records.ids('IFCPROJECT').some((project) => {
    const assignment = slotRef(records.slots(project)?.[8]); // IfcProject.UnitsInContext
    if (records.type(assignment) !== 'IFCUNITASSIGNMENT') return false;
    return (listItems(records.slots(assignment)?.[0] ?? '') ?? []).some((ref) => {
      const id = slotRef(ref);
      const slots = records.slots(id);
      return slots !== undefined && withoutComments(slots[1] ?? '').toUpperCase() === '.TIMEUNIT.'
        && !(records.type(id) === 'IFCSIUNIT' && slotUnset(slots[2]) && withoutComments(slots[3] ?? '').toUpperCase() === '.SECOND.');
    });
  });
}
