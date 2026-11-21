/* SPDX-License-Identifier: MPL-2.0 */

import { withoutComments } from './step-comment-skip.js';
import { slotRef } from './schema-converter-structural-source.js';
import { decimalSeconds } from './schema-converter-durations.js';

export const DATE_CARRIERS = new Set(['IFCCALENDARDATE', 'IFCDATEANDTIME', 'IFCLOCALTIME', 'IFCCOORDINATEDUNIVERSALTIMEOFFSET']);

export interface DateRecord { readonly type: string; readonly slots: readonly string[] }
interface Day { year: number; month: number; day: number }
interface Clock { hour: number; minute: number; second: string; zone: number | null }
export type CalendarKind = 'DATE' | 'DATETIME' | 'TIME';

const two = (n: number) => String(n).padStart(2, '0');
const integer = (token: string) => /^[+-]?\d+$/.test(token) ? Number(token) : NaN;
const unset = (token: string) => token === '$' || token === '*';

function validDay(year: number, month: number, day: number): Day | null {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  return year >= 1 && year <= 9999 && day >= 1 && day <= days ? { year, month, day } : null;
}

function legacyDay(record: DateRecord | undefined): Day | null {
  if (record?.type !== 'IFCCALENDARDATE' || record.slots.length !== 3) return null;
  const [d, m, y] = record.slots.map(withoutComments).map(integer);
  return validDay(y, m, d);
}

function oldZone(record: DateRecord | undefined): number | null {
  if (record?.type !== 'IFCCOORDINATEDUNIVERSALTIMEOFFSET' || record.slots.length !== 3) return null;
  const [h, m, sense] = record.slots.map(withoutComments);
  const hour = integer(h), minute = unset(m) ? 0 : integer(m);
  const sign = sense.toUpperCase() === '.AHEAD.' ? 1 : sense.toUpperCase() === '.BEHIND.' ? -1 : 0;
  return sign && hour >= 0 && hour < 24 && minute >= 0 && minute < 60 ? sign * (hour * 60 + minute) : null;
}

function legacyClock(record: DateRecord | undefined, read: (id: number | null) => DateRecord | undefined): Clock | null {
  if (record?.type !== 'IFCLOCALTIME' || record.slots.length !== 5) return null;
  const [h, m, s, z, daylight] = record.slots.map(withoutComments);
  const hour = integer(h), minute = unset(m) ? 0 : integer(m);
  const second = unset(s) ? '0' : decimalSeconds(s);
  if (second === null || second.startsWith('-')) return null;
  const [whole, fraction] = second.split('.');
  if (!(hour >= 0 && hour < 24 && minute >= 0 && minute < 60 && Number(whole) < 60)) return null;
  const zone = unset(z) ? null : oldZone(read(slotRef(z)));
  if (zone === null && !unset(z)) return null;
  const dst = unset(daylight) ? 0 : integer(daylight);
  if (!(dst >= 0 && dst <= 2) || (zone === null && dst !== 0) || Math.abs((zone ?? 0) + dst * 60) >= 1440) return null;
  return { hour, minute, second: whole.padStart(2, '0') + (fraction ? '.' + fraction : ''), zone: zone === null ? null : zone + dst * 60 };
}

export function fromLegacyDate(ref: string, kind: CalendarKind, read: (id: number | null) => DateRecord | undefined): string | null {
  const record = read(slotRef(ref));
  const split = kind === 'DATETIME' && record?.type === 'IFCDATEANDTIME' && record.slots.length === 2;
  const d = kind === 'TIME' ? null : legacyDay(split ? read(slotRef(record.slots[0])) : record);
  const t = kind === 'DATE' ? null : legacyClock(split ? read(slotRef(record.slots[1])) : record, read);
  if ((kind !== 'TIME' && !d) || (kind !== 'DATE' && !t)) return null;
  const date = d ? String(d.year).padStart(4, '0') + '-' + two(d.month) + '-' + two(d.day) : '';
  if (!t) return "'" + date + "'";
  const zone = t.zone === null ? '' : t.zone === 0 ? 'Z'
    : (t.zone < 0 ? '-' : '+') + two(Math.floor(Math.abs(t.zone) / 60)) + ':' + two(Math.abs(t.zone) % 60);
  return "'" + (d ? date + 'T' : '') + two(t.hour) + ':' + two(t.minute) + ':' + t.second + zone + "'";
}

interface DateDraft { day?: Day; clock?: Clock }

function readIso(token: string, kind: CalendarKind): DateDraft | null {
  token = withoutComments(token);
  if (!token.startsWith("'") || !token.endsWith("'")) return null;
  const fields = kind === 'TIME' ? ['', token.slice(1, -1)] : token.slice(1, -1).split('T');
  if (fields.length > 2) return null;
  const [date, clock] = fields;
  if ((kind === 'DATE') !== (clock === undefined)) return null;
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const day = parts ? validDay(Number(parts[1]), Number(parts[2]), Number(parts[3])) : null;
  if (kind !== 'TIME' && !day) return null;
  if (clock === undefined) return day ? { day } : null;
  const t = /^(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)(?:([+-])(\d{2}):(\d{2})|(Z))?$/.exec(clock);
  if (!t || Number(t[1]) >= 24 || Number(t[2]) >= 60 || Number(t[3].slice(0, 2)) >= 60
    || (t[4] && (Number(t[5]) >= 24 || Number(t[6]) >= 60))) return null;
  const zone = t[4] ? (t[4] === '-' ? -1 : 1) * (Number(t[5]) * 60 + Number(t[6])) : t[7] ? 0 : null;
  return { day: day ?? undefined, clock: { hour: Number(t[1]), minute: Number(t[2]), second: t[3], zone } };
}

export function toLegacyDate(token: string, kind: CalendarKind, next: () => number): { ref: string; records: string[] } | null {
  const draft = readIso(token, kind);
  if (!draft) return null;
  const records: string[] = [];
  const add = (body: string) => {
    const ref = '#' + next();
    records.push(ref + '=' + body + ';');
    return ref;
  };
  const { day, clock } = draft;
  const date = day ? add('IFCCALENDARDATE(' + day.day + ',' + day.month + ',' + day.year + ')') : null;
  if (!clock) return date ? { ref: date, records } : null;
  const { hour, minute, second, zone } = clock;
  const absolute = Math.abs(zone ?? 0);
  const offset = zone === null ? '$' : add('IFCCOORDINATEDUNIVERSALTIMEOFFSET('
    + Math.floor(absolute / 60) + ',' + absolute % 60 + ',' + (zone < 0 ? '.BEHIND.' : '.AHEAD.') + ')');
  const sec = second.replace(/^0(?=\d)/, '') + (second.includes('.') ? '' : '.');
  const time = add('IFCLOCALTIME(' + hour + ',' + minute + ',' + sec + ',' + offset + ',$)');
  const ref = date ? add('IFCDATEANDTIME(' + date + ',' + time + ')') : time;
  return { ref, records };
}
