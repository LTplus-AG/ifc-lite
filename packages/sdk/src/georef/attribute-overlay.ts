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
export const CRS_TEXT_FIELDS: readonly string[] = Object.freeze(['Name', 'Description', 'GeodeticDatum', 'VerticalDatum', 'MapProjection', 'MapZone']);

/** The three coordinates an IfcMapConversion cannot do without: an unset one reads back as 0. */
export const MANDATORY_MC_FIELDS: readonly string[] = Object.freeze(['Eastings', 'Northings', 'OrthogonalHeight']);
/** Attributes only IfcMapConversionScaled has; the exporter drops a named edit of them on a plain conversion. */
export const SCALED_ONLY_MC_FIELDS: readonly string[] = Object.freeze(['FactorX', 'FactorY', 'FactorZ']);

/**
 * The exporter's reading of a numeric edit of a REAL slot (`serializeNamedAttribute`): empty is unset (`$`), a
 * finite number is a number, and anything else (`$`, `Infinity`, an overflowing literal, text) is DECLINED: the
 * file keeps its own value and the exporter warns. `undefined` is that decline: this overlay cannot state it.
 */
export function numberOf(raw: string): number | null | undefined {
  const text = raw.trim();
  if (text === '') return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Whether an edit of conversion attribute `name` to `raw` is one `get()` can state: the attribute exists on the
 * record's class, and the value is one the exporter writes verbatim (an unset mandatory coordinate is not: it reads as 0).
 */
export function interpretsMcEdit(name: string, raw: string, scaled: boolean): boolean {
  if (SCALED_ONLY_MC_FIELDS.includes(name) && !scaled) return false;
  const n = numberOf(raw);
  return n !== undefined && !(n === null && MANDATORY_MC_FIELDS.includes(name));
}

/** Whether `get()` can state an edit of CRS text attribute `name` to `raw`: `Name` is mandatory, and an unset one reads back as ''. */
export function interpretsCrsEdit(name: string, raw: string): boolean {
  return CRS_TEXT_FIELDS.includes(name) && !(name === 'Name' && raw === '$');
}

/** A text edit as `serializeStringSlot` writes it: `$` is unset, `''` stays an empty string, anything else is itself. */
function textOf(raw: string): string | null {
  return raw === '$' ? null : raw;
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
      if (!interpretsMcEdit(name, value, mc.type === 'IfcMapConversionScaled')) continue;
      const n = numberOf(value) as number | null;
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
      if (!interpretsCrsEdit(name, value) || exporterKey(name) in (written?.projectedCRS ?? {})) continue;
      const t = textOf(value);
      if (t === null) delete fields[name]; else fields[name] = t;
      changed = true;
    }
    next.ProjectedCRS = compact(fields) as unknown as typeof crs;
  }
  return changed ? next : state;
}
