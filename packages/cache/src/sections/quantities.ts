/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * QuantityTable serialization
 */

import type { QuantityTable, QuantitySet, StringTable } from '@ifc-lite/data';
import { comparePropertyValues } from '@ifc-lite/data';
import { BufferWriter, BufferReader } from '../utils/buffer-utils.js';

/**
 * Write QuantityTable to buffer
 */
export function writeQuantities(writer: BufferWriter, quantities: QuantityTable): void {
  const count = quantities.count;

  writer.writeUint32(count);

  writer.writeTypedArray(quantities.entityId);
  writer.writeTypedArray(quantities.qsetName);
  writer.writeTypedArray(quantities.quantityName);
  writer.writeTypedArray(quantities.quantityType);
  writer.writeTypedArray(quantities.value);
  writer.writeTypedArray(quantities.unitId);
  writer.writeTypedArray(quantities.formula);

  // Write indices
  writeIndex(writer, quantities.entityIndex);
  writeIndex(writer, quantities.qsetIndex);
  writeIndex(writer, quantities.quantityIndex);
}

/**
 * Read QuantityTable from buffer
 */
export function readQuantities(reader: BufferReader, strings: StringTable): QuantityTable {
  const count = reader.readUint32();

  const entityId = reader.readUint32Array(count);
  const qsetName = reader.readUint32Array(count);
  const quantityName = reader.readUint32Array(count);
  const quantityType = reader.readUint8Array(count);
  const value = reader.readFloat64Array(count);
  const unitId = reader.readInt32Array(count);
  const formula = reader.readUint32Array(count);

  const entityIndex = readIndex(reader);
  const qsetIndex = readIndex(reader);
  const quantityIndex = readIndex(reader);

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
          qsets.set(qsetNameStr, {
            name: qsetNameStr,
            quantities: [],
          });
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

    // Mirrors the columnar implementation in `@ifc-lite/data`'s
    // `quantityTableFromColumns`. A restored table that omitted this would
    // still answer `whereProperty` correctly, but only by resolving every
    // candidate through `getForEntity` — see the note on `findByQuantity` in
    // `quantity-table.ts`.
    findByQuantity: (quantName, operator, filterValue, qset) => {
      const quantIdx = strings.indexOf(quantName);
      if (quantIdx < 0) return [];

      const qsetIdx = qset === undefined ? -1 : strings.indexOf(qset);
      if (qset !== undefined && qsetIdx < 0) return [];

      const rowIndices = quantityIndex.get(quantIdx) || [];
      const results: number[] = [];

      for (const idx of rowIndices) {
        if (qsetIdx >= 0 && qsetName[idx] !== qsetIdx) continue;
        if (comparePropertyValues(value[idx], operator, filterValue)) {
          results.push(entityId[idx]);
        }
      }

      return results;
    },

    // See `QuantityTable.sumByType`'s doc in `@ifc-lite/data`'s
    // `quantity-table.ts`: a cache-restored table has no per-row entity-type
    // data either, so `elementType` throws rather than being silently
    // dropped (it used to return the unfiltered total).
    sumByType: (quantName, elementType) => {
      if (elementType !== undefined) {
        throw new Error(
          'QuantityTable.sumByType: elementType filtering is not supported by a ' +
            'cache-restored table — it has no per-row entity-type data. Resolve entity ids ' +
            'via entities.getByType(elementType) and sum the matching rows yourself.',
        );
      }
      const quantIdx = strings.indexOf(quantName);
      if (quantIdx < 0) return 0;

      const rowIndices = quantityIndex.get(quantIdx) || [];
      let sum = 0;

      for (const idx of rowIndices) {
        sum += value[idx];
      }

      return sum;
    },
  };
}

function writeIndex(writer: BufferWriter, index: Map<number, number[]>): void {
  writer.writeUint32(index.size);
  for (const [key, values] of index) {
    writer.writeUint32(key);
    writer.writeUint32(values.length);
    for (const v of values) {
      writer.writeUint32(v);
    }
  }
}

function readIndex(reader: BufferReader): Map<number, number[]> {
  const size = reader.readUint32();
  const index = new Map<number, number[]>();
  for (let i = 0; i < size; i++) {
    const key = reader.readUint32();
    const valueCount = reader.readUint32();
    const values: number[] = [];
    for (let j = 0; j < valueCount; j++) {
      values.push(reader.readUint32());
    }
    index.set(key, values);
  }
  return index;
}
