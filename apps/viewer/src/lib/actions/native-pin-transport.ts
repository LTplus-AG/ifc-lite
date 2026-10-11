/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

type PinDomain = 'nativeStoreyReassignments' | 'nativeStructural' | 'nativeCost';
const domains: readonly PinDomain[] = ['nativeStoreyReassignments', 'nativeStructural', 'nativeCost'];
function offered(row: Record<string, unknown>, field: PinDomain): boolean {
  const pin = row[field];
  return field === 'nativeStoreyReassignments' ? Array.isArray(pin) && pin.length > 0
    : record(pin) && pin.status === 'available' && (record(pin.expected) || Array.isArray(pin.expectedJsonParts));
}

/** Reserve ordinary selected facts before offering complete optional native pins. */
export function nativePinBaseline(value: unknown, selected: readonly PinDomain[] = domains): unknown {
  if (!record(value)) return value;
  let result = value;
  for (const field of selected) {
    if (!offered(value, field)) continue;
    if (field === 'nativeStoreyReassignments') result = { ...result, [field]: null, nativeAuthoringAvailability: {
      ...(record(result.nativeAuthoringAvailability) ? result.nativeAuthoringAvailability : {}), storeyReassignment: 'unavailable-transport-budget',
    } };
    else {
      const pin = value[field]; if (!record(pin)) continue;
      result = { ...result, [field]: { ...pin, status: 'unavailable-transport-budget',
        ...('expected' in pin ? { expected: null } : {}), ...('expectedJsonParts' in pin ? { expectedJsonParts: null } : {}),
      } };
    }
  }
  return result;
}

/** Admit unchanged whole domains against the measured complete envelope.
 * Storey domains are considered first, admitting each unchanged whole row pin. */
export function admitNativePins(original: readonly unknown[], rows: unknown[],
  measure: (rows: unknown[]) => number, textLimit: number,
  project: (pin: unknown) => unknown = pin => pin, selected: readonly PinDomain[] = domains): void {
  for (const field of selected) for (let i = 0; i < rows.length; i++) {
    const source = original[i], row = rows[i];
    if (!record(source) || !record(row) || !offered(source, field)) continue;
    const pin = source[field], projected = project(pin);
    if (JSON.stringify(projected) !== JSON.stringify(pin)) continue;
    const candidate = { ...row, [field]: projected, ...(field === 'nativeStoreyReassignments' ? { nativeAuthoringAvailability: {
      ...(record(row.nativeAuthoringAvailability) ? row.nativeAuthoringAvailability : {}), storeyReassignment: 'available',
    } } : {}) };
    const proposed = rows.map((item, index) => index === i ? candidate : item);
    if (measure(proposed) > textLimit) continue;
    rows[i] = candidate;
  }
}

/** Separate wire projection: ownership sidecars and frozen captures stay untouched. */
export function projectNativeWire(payload: string, selection: import('./selection-grounding').SelectionGrounding | undefined,
  selectionText: (selection: import('./selection-grounding').SelectionGrounding) => string,
  includePayload: boolean, measure?: (payload: string, attachment: string | undefined) => number): { payload: string; attachment: string | undefined } {
  const parsed: unknown = includePayload ? JSON.parse(payload) : null;
  const evidence = record(parsed) && record(parsed.evidence) ? parsed.evidence : null;
  const originalRows = evidence && Array.isArray(evidence.rows) ? evidence.rows : [];
  const sources = originalRows.map(row => record(row) ? row.data : null);
  const offset = sources.length;
  sources.push(...(selection?.elements ?? []));
  if (!sources.some(value => record(value) && domains.some(field => offered(value, field)))) {
    return { payload, attachment: selection ? selectionText(selection) : undefined };
  }
  const rows = sources.map(value => nativePinBaseline(value));
  const serialize = (values: unknown[]) => {
    const projectedRows = originalRows.map((row, index) => record(row) ? { ...row, data: values[index] } : row);
    const projectedPayload = evidence && record(parsed)
      ? JSON.stringify({ ...parsed, evidence: { ...evidence, rows: projectedRows } }) : payload;
    const attachment = selection ? selectionText({ ...selection,
      elements: values.slice(offset) as import('./selection-grounding').SelectionElement[] }) : undefined;
    return { payload: projectedPayload, attachment };
  };
  if (measure) admitNativePins(sources, rows, values => {
    const wire = serialize(values);
    return measure(wire.payload, wire.attachment);
  }, 90_000);
  return serialize(rows);
}
