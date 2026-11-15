/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ordinary attribute edits (`bim.mutate.setAttribute`, MCP `entity_set_attribute`)
 * of an existing `IfcMapConversion` / `IfcProjectedCRS` reach the STEP export,
 * so `get()` has to show them. The exporter applies attribute edits first and
 * a session's georeferencing write after, so a field the write sets wins and
 * is skipped here.
 *
 * Only what can be stated exactly is applied: a number for a MapConversion
 * numeric attribute and plain text for a CRS text attribute. Attributes that
 * hold references (`MapUnit`, `SourceCRS`, `TargetCRS`) are not read back
 * through this overlay; neither are numeric values that do not parse.
 */

import type { MutablePropertyView } from '@ifc-lite/mutations';
import { exporterKey, MC_FIELDS } from './plan.js';
import { rotationOf, compact } from './read.js';
import type { GeoreferencingState } from './types.js';

/** `CRS_FIELDS` without `MapUnit` (a reference attribute); a literal so the module does no work at import. */
export const CRS_TEXT_FIELDS: readonly string[] = ['Name', 'Description', 'GeodeticDatum', 'VerticalDatum', 'MapProjection', 'MapZone'];

/**
 * The exporter's reading of a numeric edit (`serializeAttributeValue`): empty or `$` is unset, an
 * overflowing literal is written as `$`, a finite number is a number, anything else is not stated here.
 */
export function numberOf(raw: string): number | null | undefined {
  const text = raw.trim();
  if (text === '' || text === '$') return null;
  const n = Number(text);
  if (Number.isNaN(n)) return undefined;
  return Number.isFinite(n) ? n : null;
}

/** A text edit is the plain text (the exporter quotes and escapes it); empty is unset. */
function textOf(raw: string): string | null {
  return raw === '' ? null : raw;
}

/** `state` with this view's attribute edits of its georeferencing records applied; `state` itself when there are none. */
export function withAttributeEdits(
  state: GeoreferencingState,
  view: MutablePropertyView,
  written: { mapConversion?: object; projectedCRS?: object } | null = null,
): GeoreferencingState {
  const next: GeoreferencingState = { ...state };
  let changed = false;
  const mc = state.MapConversion;
  if (mc?.expressId !== undefined && mc.type !== 'ePSet_MapConversion') {
    const fields: Record<string, unknown> = { ...mc };
    for (const { name, value } of view.getAttributeMutationsForEntity(mc.expressId)) {
      if (!MC_FIELDS.includes(name as (typeof MC_FIELDS)[number]) || exporterKey(name) in (written?.mapConversion ?? {})) continue;
      const n = numberOf(value);
      if (n === undefined) continue;
      if (n === null) delete fields[name]; else fields[name] = n;
      changed = true;
    }
    next.MapConversion = compact(fields) as unknown as typeof mc;
    next.rotationDegrees = rotationOf(next.MapConversion);
  }
  const crs = state.ProjectedCRS;
  if (crs?.expressId !== undefined && crs.type !== 'ePSet_ProjectedCRS') {
    const fields: Record<string, unknown> = { ...crs };
    for (const { name, value } of view.getAttributeMutationsForEntity(crs.expressId)) {
      if (!CRS_TEXT_FIELDS.includes(name) || exporterKey(name) in (written?.projectedCRS ?? {})) continue;
      const t = textOf(value);
      if (t === null) delete fields[name]; else fields[name] = t;
      changed = true;
    }
    next.ProjectedCRS = compact(fields) as unknown as typeof crs;
  }
  return changed ? next : state;
}
