/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { editHostedElementInStore, readHostedElementSize, readHostedFill, type HostedElementEdit, type HostedElementSize, type HostedFillRead } from '@ifc-lite/create';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { StoreEditor } from '@ifc-lite/mutations';
import { getModelLengthUnitScale } from '@/lib/length-unit-scale';
import { parseLength, parsePoint, record } from './model-authoring-fields';
import type { AuthoringUnits, ModelAuthoringBatch } from './model-authoring';
import { uniqueSplitGuid } from './model-authoring-split';

export type ExpectedHostedEdit = HostedFillRead & { size: HostedElementSize | null };
const editFields = ['Offset', 'Sill', 'OverallWidth', 'OverallHeight'] as const;

function keys(value: unknown, names: readonly string[], at: string): Record<string, unknown> {
  if (!record(value)) throw new Error(`${at} must state the native fields`);
  for (const key of Object.keys(value)) if (!names.includes(key)) throw new Error(`${at}: unsupported native field ${key}`);
  return value;
}
function id(value: unknown, at: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${at} must be a positive native EXPRESS id`);
  return value;
}
export function parseExpectedHostedEdit(value: unknown, units: AuthoringUnits, at: string): ExpectedHostedEdit {
  const v = keys(value, ['hostId', 'openingId', 'fillingId', 'locationPointId', 'location', 'offset', 'sill', 'size'], at);
  const range = { min: -Number.MAX_VALUE, max: Number.MAX_VALUE, signed: true };
  const size = v.size === null ? null : keys(v.size, ['OverallWidth', 'OverallHeight'], `${at} size`);
  const dimension = (value: unknown, field: string) => {
    const result = parseLength(value, units, { min: 0, max: Number.MAX_VALUE }, `${at} ${field}`);
    if (result <= 0) throw new Error(`${at} ${field} must be positive`);
    return result;
  };
  return { hostId: id(v.hostId, `${at} hostId`), openingId: id(v.openingId, `${at} openingId`),
    fillingId: v.fillingId === null ? null : id(v.fillingId, `${at} fillingId`), locationPointId: id(v.locationPointId, `${at} locationPointId`),
    location: parsePoint(v.location, units, range, `${at} location`), offset: parseLength(v.offset, units, range, `${at} offset`),
    sill: parseLength(v.sill, units, range, `${at} sill`), size: size && {
      OverallWidth: dimension(size.OverallWidth, 'OverallWidth'), OverallHeight: dimension(size.OverallHeight, 'OverallHeight') } };
}
export function parseHostedEdit(value: unknown, units: AuthoringUnits, at: string): HostedElementEdit {
  const v = keys(value, editFields, at), result: HostedElementEdit = {};
  if (Object.keys(v).length === 0) throw new Error(`${at}: state at least one changed native field`);
  for (const key of editFields) if (v[key] !== undefined) {
    const size = key.startsWith('Overall');
    const n = parseLength(v[key], units, { min: size ? .000001 : -10000, max: size ? 1000 : 10000, signed: !size }, `${at} ${key}`);
    Object.assign(result, { [key]: n });
  }
  if (Object.keys(result).length === 0) throw new Error(`${at}: state at least one changed native field`);
  return result;
}
export function hostedEditMetres(edit: HostedElementEdit, units: AuthoringUnits): HostedElementEdit {
  return Object.fromEntries(Object.entries(edit).map(([key, value]) => [key, units === 'mm' ? value / 1000 : value]));
}
/** Read exactly the existing canonical host/opening/filling binding and pose.
 * Native ids keep their meanings; only dimensional values use declared units. */
export function readExpectedHostedEdit(store: IfcDataStore, editor: StoreEditor, expressId: number, units: AuthoringUnits): ExpectedHostedEdit {
  if (!store.source || store.source.byteLength === 0) throw new Error('Native hosted edits require an IFC2X3, IFC4 or IFC4X3 source; the original geometry is unavailable');
  const view = editor.getMutationView(), read = readHostedFill(store, expressId, view);
  if (!read) throw new Error('The native hosted binding or placement is unavailable');
  const size = readHostedElementSize(store, expressId, view), factor = units === 'mm' ? 1000 : 1;
  const scale = getModelLengthUnitScale(store);
  return { ...read, offset: read.offset * factor, sill: read.sill * factor,
    location: read.location.map(value => value * scale * factor) as [number, number, number],
    size: size && { OverallWidth: size.OverallWidth * factor, OverallHeight: size.OverallHeight * factor } };
}
export function sameHostedEdit(a: ExpectedHostedEdit, b: ExpectedHostedEdit): boolean {
  return a.hostId === b.hostId && a.openingId === b.openingId && a.fillingId === b.fillingId && a.locationPointId === b.locationPointId
    && a.offset === b.offset && a.sill === b.sill && a.location.every((value, axis) => value === b.location[axis])
    && (a.size === null ? b.size === null : b.size !== null && a.size.OverallWidth === b.size.OverallWidth && a.size.OverallHeight === b.size.OverallHeight);
}
export function writeHostedEdit(batch: ModelAuthoringBatch, store: IfcDataStore, editor: StoreEditor, expressId: number,
  expected: ExpectedHostedEdit, edit: HostedElementEdit, globalId: string): HostedFillRead {
  const current = readExpectedHostedEdit(store, editor, expressId, batch.units);
  if (!uniqueSplitGuid(store, editor, globalId)) throw new Error('The native hosted target GlobalId is not unique in its owning model');
  if (!sameHostedEdit(current, expected)) throw new Error('The native hosted binding, position or dimensions changed after review');
  return editHostedElementInStore(store, editor, expressId, hostedEditMetres(edit, batch.units));
}
