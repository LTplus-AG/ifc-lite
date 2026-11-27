/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcDataStore } from '@ifc-lite/parser';
import { getCompleteEntityIndex } from './entity-iteration.js';
import { readStepSlots } from './step-argument-parser.js';
import { holdsValue, withoutComments } from './step-comment-skip.js';

import { listItems } from './schema-converter-structural-axes.js';
import { slotRef } from './schema-converter-structural-source.js';

/** Resolve unit ownership in source id space, independent of STEP record order. */
export function inheritedUnitLookup(model: IfcDataStore, included?: ReadonlySet<number>) {
  const index = getCompleteEntityIndex(model);
  const cache = new Map<number, boolean>();
  function selectionHasExplicitUnit(type: string, selection: string) {
    if (type.toUpperCase() !== 'IFCPROPERTYENUMERATEDVALUE') return false;
    const token = withoutComments(readStepSlots(selection)?.slots[3] ?? '');
    if (!/^#\d+$/.test(token)) return false;
    const id = Number(token.slice(1));
    const cached = cache.get(id);
    if (cached !== undefined) return cached;
    const ref = index.get(id);
    const domain = ref?.type.toUpperCase() === 'IFCPROPERTYENUMERATION'
      ? model.source?.decodeUtf8(ref.byteOffset, ref.byteOffset + ref.byteLength) : undefined;
    const explicit = domain !== undefined && holdsValue(readStepSlots(domain)?.slots[2] ?? '');
    cache.set(id, explicit);
    return explicit;
  }
  type SampleUnit = 'explicit' | 'project' | 'mixed';
  let samples: Map<number, SampleUnit> | undefined;
  function sampleUnit(type: string, id: number): SampleUnit | undefined {
    if (type !== 'IFCTIMESERIESVALUE' && type !== 'IFCIRREGULARTIMESERIESVALUE') return undefined;
    if (samples) return samples.get(id);
    samples = new Map();
    for (const [ownerId, owner] of index) {
      const name = owner.type.toUpperCase();
      if (name !== 'IFCREGULARTIMESERIES' && name !== 'IFCIRREGULARTIMESERIES') continue;
      if (included && !included.has(ownerId)) continue;
      const text = model.source?.decodeUtf8(owner.byteOffset, owner.byteOffset + owner.byteLength);
      const slots = text && readStepSlots(text)?.slots;
      if (!slots) continue;
      const unit = slotRef(slots[7]) === null ? 'project' : 'explicit';
      // In all three schemas, only the regular series inserts TimeStep before Values.
      for (const token of listItems(slots[name === 'IFCREGULARTIMESERIES' ? 9 : 8]) ?? []) {
        const sample = slotRef(token);
        if (sample === null) continue;
        const previous = samples.get(sample);
        samples.set(sample, previous && previous !== unit ? 'mixed' : unit);
      }
    }
    return samples.get(id);
  }
  let rows: Map<number, Set<number>[]> | undefined;
  function indexTableOwners() {
    const owners = new Map<number, Set<number>[]>();
    for (const [tableId, table] of index) {
      if (table.type.toUpperCase() !== 'IFCTABLE' || (included && !included.has(tableId))) continue;
      const text = model.source?.decodeUtf8(table.byteOffset, table.byteOffset + table.byteLength);
      const slots = text && readStepSlots(text)?.slots;
      if (!slots) continue;
      const columns = new Set<number>();
      listItems(slots[2])?.forEach((token, position) => {
        const columnId = slotRef(token);
        const column = columnId === null ? undefined : index.get(columnId);
        if (column?.type.toUpperCase() !== 'IFCTABLECOLUMN') return;
        const record = model.source?.decodeUtf8(column.byteOffset, column.byteOffset + column.byteLength);
        if (record && slotRef(readStepSlots(record)?.slots[3]) !== null) columns.add(position);
      });
      for (const token of listItems(slots[1]) ?? []) {
        const row = slotRef(token);
        if (row === null) continue;
        const previous = owners.get(row);
        if (previous) previous.push(columns);
        else owners.set(row, [columns]);
      }
    }
    return owners;
  }
  function tableCellNormalizer(type: string, id: number) {
    if (type !== 'IFCTABLEROW' || model.schemaVersion === 'IFC2X3') return undefined;
    rows ??= indexTableOwners();
    const owners = rows.get(id);
    if (!owners?.some(columns => columns.size)) return undefined;
    const counts = new Map<number, number>();
    for (const columns of owners) {
      for (const col of columns) counts.set(col, (counts.get(col) ?? 0) + 1);
    }
    return (cell: string, col: number, scale: (value: string) => string) => {
      const explicit = counts.get(col);
      if (explicit === owners.length) return cell;
      const scaled = scale(cell);
      if (explicit && scaled !== cell) {
        throw new Error(`Cannot normalize shared table row #${id} at column ${col + 1} with both project and explicit units`);
      }
      return scaled;
    };
  }
  return { selectionHasExplicitUnit, tableCellNormalizer, sampleUnit };
}
