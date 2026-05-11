/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Quantity table - columnar storage for quantities
 * Similar to properties but always numeric
 */

import type { StringTable } from './string-table.js';
import { QuantityType } from './types.js';

export interface QuantitySet {
  name: string;
  quantities: Quantity[];
}

export interface Quantity {
  name: string;
  type: QuantityType;
  value: number;
  unit?: string;
  formula?: string;
}

export interface QuantityTable {
  readonly count: number;
  
  entityId: Uint32Array;
  qsetName: Uint32Array;
  quantityName: Uint32Array;
  quantityType: Uint8Array;
  value: Float64Array;
  unitId: Int32Array;
  formula: Uint32Array;
  
  entityIndex: Map<number, number[]>;
  qsetIndex: Map<number, number[]>;
  quantityIndex: Map<number, number[]>;
  
  getForEntity(expressId: number): QuantitySet[];
  getQuantityValue(expressId: number, qsetName: string, quantName: string): number | null;
  sumByType(quantityName: string, elementType?: number): number;
}

export class QuantityTableBuilder {
  private strings: StringTable;
  private rows: QuantityRow[] = [];
  
  constructor(strings: StringTable) {
    this.strings = strings;
  }
  
  add(row: QuantityRow): void {
    this.rows.push(row);
  }
  
  build(): QuantityTable {
    const count = this.rows.length;

    const entityId = new Uint32Array(count);
    const qsetName = new Uint32Array(count);
    const quantityName = new Uint32Array(count);
    const quantityType = new Uint8Array(count);
    const value = new Float64Array(count);
    const unitId = new Int32Array(count).fill(-1);
    const formula = new Uint32Array(count).fill(0);

    for (let i = 0; i < count; i++) {
      const row = this.rows[i];
      entityId[i] = row.entityId;
      qsetName[i] = this.strings.intern(row.qsetName);
      quantityName[i] = this.strings.intern(row.quantityName);
      quantityType[i] = row.quantityType;
      value[i] = row.value;
      if (row.unitId !== undefined) unitId[i] = row.unitId;
      if (row.formula) formula[i] = this.strings.intern(row.formula);
    }

    return quantityTableFromColumns(
      { count, entityId, qsetName, quantityName, quantityType, value, unitId, formula },
      this.strings,
    );
  }
}

/**
 * Plain-data column representation of a `QuantityTable`. Indices are
 * derived in `quantityTableFromColumns`.
 */
export interface QuantityTableColumns {
  count: number;
  entityId: Uint32Array;
  qsetName: Uint32Array;
  quantityName: Uint32Array;
  quantityType: Uint8Array;
  value: Float64Array;
  unitId: Int32Array;
  formula: Uint32Array;
}

/** Rebuild a live `QuantityTable` (closures + indices) from column data. */
export function quantityTableFromColumns(columns: QuantityTableColumns, strings: StringTable): QuantityTable {
  const { count, entityId, qsetName, quantityName, quantityType, value, unitId, formula } = columns;

  const entityIndex = new Map<number, number[]>();
  const qsetIndex = new Map<number, number[]>();
  const quantityIndex = new Map<number, number[]>();
  for (let i = 0; i < count; i++) {
    addToIndex(entityIndex, entityId[i], i);
    addToIndex(qsetIndex, qsetName[i], i);
    addToIndex(quantityIndex, quantityName[i], i);
  }

  return {
    count,
    entityId,
    qsetName,
    quantityName,
    quantityType,
    value,
    unitId,
    formula,
    entityIndex,
    qsetIndex,
    quantityIndex,

    getForEntity: (id) => {
      const rowIndices = entityIndex.get(id) || [];
      const qsets = new Map<string, QuantitySet>();
      for (const idx of rowIndices) {
        const qsetNameStr = strings.get(qsetName[idx]);
        if (!qsets.has(qsetNameStr)) {
          qsets.set(qsetNameStr, { name: qsetNameStr, quantities: [] });
        }
        const qset = qsets.get(qsetNameStr)!;
        const quantNameStr = strings.get(quantityName[idx]);
        qset.quantities.push({
          name: quantNameStr,
          type: quantityType[idx],
          value: value[idx],
          formula: formula[idx] > 0 ? strings.get(formula[idx]) : undefined,
        });
      }
      return Array.from(qsets.values());
    },

    getQuantityValue: (id, qset, quant) => {
      const rowIndices = entityIndex.get(id) || [];
      const qsetIdx = strings.indexOf(qset);
      const quantIdx = strings.indexOf(quant);
      for (const idx of rowIndices) {
        if (qsetName[idx] === qsetIdx && quantityName[idx] === quantIdx) {
          return value[idx];
        }
      }
      return null;
    },

    sumByType: (quantName) => {
      const quantIdx = strings.indexOf(quantName);
      if (quantIdx < 0) return 0;
      const rowIndices = quantityIndex.get(quantIdx) || [];
      let sum = 0;
      for (const idx of rowIndices) sum += value[idx];
      return sum;
    },
  };
}

/** Extract column data from a `QuantityTable` for transport. */
export function quantityTableToColumns(table: QuantityTable): QuantityTableColumns {
  return {
    count: table.count,
    entityId: table.entityId,
    qsetName: table.qsetName,
    quantityName: table.quantityName,
    quantityType: table.quantityType,
    value: table.value,
    unitId: table.unitId,
    formula: table.formula,
  };
}

interface QuantityRow {
  entityId: number;
  qsetName: string;
  quantityName: string;
  quantityType: QuantityType;
  value: number;
  unitId?: number;
  formula?: string;
}

function addToIndex(index: Map<number, number[]>, key: number, value: number): void {
  let list = index.get(key);
  if (!list) {
    list = [];
    index.set(key, list);
  }
  list.push(value);
}
