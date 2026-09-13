/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * IFC2X3 `IfcCostSchedule` attribute layout, used by `cost-extractor.ts`.
 *
 * In IFC2X3 `IfcControl` adds no attributes to `IfcObject`, so the schedule's
 * own attributes start at slot 5 (IFC4 inserts `Identification` there and
 * reorders the rest):
 *
 *   5 SubmittedBy, 6 PreparedBy, 7 SubmittedOn, 8 Status, 9 TargetUsers,
 *   10 UpdateDate, 11 ID, 12 PredefinedType
 *
 * `SubmittedOn`/`UpdateDate` are `IfcDateTimeSelect` — a reference to an
 * `IfcCalendarDate` or `IfcDateAndTime` entity, not the IFC4 ISO string — so
 * they are resolved here into the same `YYYY-MM-DD[THH:MM:SS]` shape the IFC4
 * path returns.
 */

import type { EntityExtractor } from './entity-extractor.js';
import type { IfcDataStore } from './columnar-parser.js';

export const COST_SCHEDULE_ATTR_2X3 = {
  SubmittedOn: 7,
  Status: 8,
  UpdateDate: 10,
  ID: 11,
  PredefinedType: 12,
} as const;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function calendarDate(a: unknown[]): string | undefined {
  // IfcCalendarDate(DayComponent, MonthComponent, YearComponent)
  const [day, month, year] = a;
  if (typeof day !== 'number' || typeof month !== 'number' || typeof year !== 'number') return undefined;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function localTime(a: unknown[]): string | undefined {
  // IfcLocalTime(HourComponent, MinuteComponent?, SecondComponent?, Zone?, DaylightSavingOffset?)
  const [hour, minute, second] = a;
  if (typeof hour !== 'number') return undefined;
  const m = typeof minute === 'number' ? minute : 0;
  const s = typeof second === 'number' ? Math.floor(second) : 0;
  return `${pad2(hour)}:${pad2(m)}:${pad2(s)}`;
}

/**
 * Resolve an IFC2X3 `IfcDateTimeSelect` attribute (an entity reference) to an
 * ISO-like string; `undefined` for `$`, a non-reference, or an unresolvable
 * / unexpected target type.
 */
export function resolveDateTimeSelect2x3(
  extractor: EntityExtractor,
  store: IfcDataStore,
  value: unknown,
): string | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return undefined;
  const ref = store.entityIndex.byId.get(value);
  if (!ref) return undefined;
  const entity = extractor.extractEntity(ref);
  if (!entity) return undefined;
  const a = entity.attributes || [];
  const type = ref.type.toUpperCase();
  if (type === 'IFCCALENDARDATE') return calendarDate(a);
  if (type === 'IFCDATEANDTIME') {
    // IfcDateAndTime(DateComponent : IfcCalendarDate, TimeComponent : IfcLocalTime)
    const date = resolveDateTimeSelect2x3(extractor, store, a[0]);
    if (date === undefined) return undefined;
    const timeRef = typeof a[1] === 'number' ? store.entityIndex.byId.get(a[1]) : undefined;
    const time = timeRef ? extractor.extractEntity(timeRef) : null;
    const clock = time ? localTime(time.attributes || []) : undefined;
    return clock === undefined ? date : `${date}T${clock}`;
  }
  return undefined;
}
