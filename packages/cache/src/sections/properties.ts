/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * PropertyTable serialization
 */

import type { PropertyTable, PropertySet, StringTable } from '@ifc-lite/data';
import { PropertyValueType } from '@ifc-lite/data';
import { BufferWriter, BufferReader } from '../utils/buffer-utils.js';

/**
 * Write PropertyTable to buffer
 * Format:
 *   - count: uint32
 *   - entityId: Uint32Array[count]
 *   - psetName: Uint32Array[count]
 *   - psetGlobalId: Uint32Array[count]
 *   - propName: Uint32Array[count]
 *   - propType: Uint8Array[count]
 *   - valueString: Uint32Array[count]
 *   - valueReal: Float64Array[count]
 *   - valueInt: Int32Array[count]
 *   - valueBool: Uint8Array[count]
 *   - unitId: Int32Array[count]
 *   - entityIndexCount: uint32
 *   - entityIndex entries: [key:uint32, count:uint32, indices:uint32[]]...
 */
export function writeProperties(writer: BufferWriter, properties: PropertyTable): void {
  const count = properties.count;

  writer.writeUint32(count);

  writer.writeTypedArray(properties.entityId);
  writer.writeTypedArray(properties.psetName);
  writer.writeTypedArray(properties.psetGlobalId);
  writer.writeTypedArray(properties.propName);
  writer.writeTypedArray(properties.propType);
  writer.writeTypedArray(properties.valueString);
  writer.writeTypedArray(properties.valueReal);
  writer.writeTypedArray(properties.valueInt);
  writer.writeTypedArray(properties.valueBool);
  writer.writeTypedArray(properties.unitId);

  // Write entity index
  writeIndex(writer, properties.entityIndex);
  writeIndex(writer, properties.psetIndex);
  writeIndex(writer, properties.propIndex);
}

/**
 * Read PropertyTable from buffer
 */
export function readProperties(reader: BufferReader, strings: StringTable): PropertyTable {
  const count = reader.readUint32();

  const entityId = reader.readUint32Array(count);
  const psetName = reader.readUint32Array(count);
  const psetGlobalId = reader.readUint32Array(count);
  const propName = reader.readUint32Array(count);
  const propType = reader.readUint8Array(count);
  const valueString = reader.readUint32Array(count);
  const valueReal = reader.readFloat64Array(count);
  const valueInt = reader.readInt32Array(count);
  const valueBool = reader.readUint8Array(count);
  const unitId = reader.readInt32Array(count);

  const entityIndex = readIndex(reader);
  const psetIndex = readIndex(reader);
  const propIndex = readIndex(reader);

  const getPropertyValue = (idx: number): PropertyValue => {
    const type = propType[idx];
    switch (type) {
      case PropertyValueType.String:
      case PropertyValueType.Label:
      case PropertyValueType.Identifier:
      case PropertyValueType.Text:
      case PropertyValueType.Enum: {
        // valueString is a Uint32Array, so a `< 0` check is dead (the NULL
        // sentinel -1 wraps to 4294967295). Reject any index past the table so
        // a genuine NULL property value stays null instead of becoming "".
        const si = valueString[idx];
        return si >= 0 && si < strings.count ? strings.get(si) : null;
      }
      case PropertyValueType.Real:
        return valueReal[idx];
      case PropertyValueType.Integer:
        return valueInt[idx];
      case PropertyValueType.Boolean:
      case PropertyValueType.Logical:
        const boolVal = valueBool[idx];
        return boolVal === 255 ? null : boolVal === 1;
      case PropertyValueType.List:
        const listStr = strings.get(valueString[idx]);
        try {
          return JSON.parse(listStr);
        } catch {
          return [];
        }
      default:
        return null;
    }
  };

  return {
    count,
    entityId,
    psetName,
    psetGlobalId,
    propName,
    propType,
    valueString,
    valueReal,
    valueInt,
    valueBool,
    unitId,
    entityIndex,
    psetIndex,
    propIndex,

    getForEntity: (id) => {
      const rowIndices = entityIndex.get(id) || [];
      const psets = new Map<string, PropertySet>();

      for (const idx of rowIndices) {
        const psetNameStr = strings.get(psetName[idx]);
        const psetGlobalIdStr = strings.get(psetGlobalId[idx]);

        if (!psets.has(psetNameStr)) {
          psets.set(psetNameStr, {
            name: psetNameStr,
            globalId: psetGlobalIdStr,
            properties: [],
          });
        }

        const pset = psets.get(psetNameStr)!;
        const propNameStr = strings.get(propName[idx]);

        pset.properties.push({
          name: propNameStr,
          type: propType[idx],
          value: getPropertyValue(idx),
        });
      }

      return Array.from(psets.values());
    },

    getPropertyValue: (id, pset, prop) => {
      const rowIndices = entityIndex.get(id) || [];
      const psetIdx = strings.indexOf(pset);
      const propIdx = strings.indexOf(prop);

      for (const idx of rowIndices) {
        if (psetName[idx] === psetIdx && propName[idx] === propIdx) {
          return getPropertyValue(idx);
        }
      }

      return null;
    },

    findByProperty: (prop, operator, value, pset) => {
      const propIdx = strings.indexOf(prop);
      if (propIdx < 0) return [];

      // When a property-set is named, only rows in that pset match; a same-named
      // property in another pset must not. An unknown pset name matches nothing.
      const psetIdx = pset === undefined ? -1 : strings.indexOf(pset);
      if (pset !== undefined && psetIdx < 0) return [];

      const rowIndices = propIndex.get(propIdx) || [];
      const results: number[] = [];

      for (const idx of rowIndices) {
        if (psetIdx >= 0 && psetName[idx] !== psetIdx) continue;
        const propValue = getPropertyValue(idx);
        if (compareValues(propValue, operator, value)) {
          results.push(entityId[idx]);
        }
      }

      return results;
    },
  };
}

type PropertyValue = string | number | boolean | null | PropertyValue[];

function compareValues(propValue: PropertyValue, operator: string, value: PropertyValue): boolean {
  if (propValue === null || value === null) return false;

  if (typeof propValue === 'number' && typeof value === 'number') {
    switch (operator) {
      case '>=': return propValue >= value;
      case '>': return propValue > value;
      case '<=': return propValue <= value;
      case '<': return propValue < value;
      case '=':
      case '==': return propValue === value;
      case '!=': return propValue !== value;
    }
  }

  if (typeof propValue === 'string' && typeof value === 'string') {
    switch (operator) {
      case '=':
      case '==': return propValue === value;
      case '!=': return propValue !== value;
      case 'contains': return propValue.includes(value);
      case 'startsWith': return propValue.startsWith(value);
    }
  }

  return false;
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
