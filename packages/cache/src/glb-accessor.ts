/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { GLTFDocument } from './glb-types.js';
// Component types
const COMPONENT_BYTE = 5120;
const COMPONENT_UNSIGNED_BYTE = 5121;
const COMPONENT_SHORT = 5122;
const COMPONENT_UNSIGNED_SHORT = 5123;
const COMPONENT_UNSIGNED_INT = 5125;
const COMPONENT_FLOAT = 5126;

/**
 * Get the byte size for a glTF component type
 */
function getComponentSize(componentType: number): number {
  switch (componentType) {
    case COMPONENT_BYTE:
    case COMPONENT_UNSIGNED_BYTE:
      return 1;
    case COMPONENT_SHORT:
    case COMPONENT_UNSIGNED_SHORT:
      return 2;
    case COMPONENT_UNSIGNED_INT:
    case COMPONENT_FLOAT:
      return 4;
    default:
      throw new Error(`Unknown component type: ${componentType}`);
  }
}

/**
 * Get the number of components for an accessor type
 */
function getComponentCount(type: string): number {
  switch (type) {
    case 'SCALAR':
      return 1;
    case 'VEC2':
      return 2;
    case 'VEC3':
      return 3;
    case 'VEC4':
      return 4;
    case 'MAT2':
      return 4;
    case 'MAT3':
      return 9;
    case 'MAT4':
      return 16;
    default:
      throw new Error(`Unknown accessor type: ${type}`);
  }
}

/**
 * Read accessor data as a typed array
 */
export function readAccessorData(
  gltf: GLTFDocument,
  bin: Uint8Array,
  accessorIdx: number
): Float32Array | Uint32Array | Uint16Array | Uint8Array {
  const accessor = gltf.accessors?.[accessorIdx];
  if (!accessor) {
    throw new Error(`Accessor ${accessorIdx} not found`);
  }

  if (accessor.sparse) throw new Error('GLB: sparse accessors are not supported');
  const bufferView = gltf.bufferViews?.[accessor.bufferView];
  if (!bufferView) {
    throw new Error(`BufferView ${accessor.bufferView} not found`);
  }

  if (bufferView.buffer !== 0 || gltf.buffers?.[0]?.uri) throw new Error('GLB: external buffers are not supported');
  const componentSize = getComponentSize(accessor.componentType);
  const componentCount = getComponentCount(accessor.type);
  const elementSize = componentSize * componentCount;
  const byteStride = bufferView.byteStride ?? elementSize;

  const bufferOffset = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);

  // `accessor.count` comes straight from the (untrusted) GLB JSON chunk and
  // is REQUIRED by the glTF spec, but nothing here enforced that at runtime:
  // a missing/non-numeric `count` makes it `undefined`/NaN, and `NaN * x` is
  // NaN. Every arithmetic bounds comparison below (`< 0`, `> bin.byteLength`)
  // is false against NaN, so the bounds check was silently bypassed rather
  // than rejecting the malformed accessor. Control then fell through to a
  // typed-array constructor built from that same NaN count, which coerces to
  // an element count of 0 (ToIndex(NaN) === 0) — producing a silently EMPTY
  // mesh reported as a successful import instead of throwing.
  if (!Number.isInteger(accessor.count) || accessor.count < 0) {
    throw new Error(`GLB: accessor ${accessorIdx} has an invalid count: ${accessor.count}`);
  }

  // Bounds-check the full byte range this accessor claims against the actual
  // BIN chunk BEFORE slicing/constructing anything. `accessor.count` /
  // `byteOffset` come straight from the (untrusted) GLB JSON chunk; without
  // this, `bin.slice()` below silently CLAMPS on a truncated/malformed BIN
  // (fewer bytes than asked), and the typed-array constructor that follows
  // still requests the ORIGINALLY declared element count against that
  // shorter buffer — a raw `RangeError: Invalid typed array length` (or
  // "range consisting of offset and length are out of bounds", depending on
  // engine) escapes instead of a diagnosable domain error.
  const neededBytes = byteStride === elementSize
    ? accessor.count * elementSize
    : accessor.count > 0
      ? (accessor.count - 1) * byteStride + elementSize
      : 0;
  if (![bufferOffset, neededBytes, byteStride, bufferView.byteLength, accessor.byteOffset ?? 0, bufferView.byteOffset ?? 0].every(Number.isSafeInteger) || byteStride < elementSize || (accessor.byteOffset ?? 0) < 0 || (bufferView.byteOffset ?? 0) < 0 || (accessor.byteOffset ?? 0) + neededBytes > bufferView.byteLength || bufferOffset < 0 || neededBytes < 0 || bufferOffset + neededBytes > bin.byteLength) {
    throw new Error(
      `GLB: accessor ${accessorIdx} reads bytes [${bufferOffset}, ${bufferOffset + neededBytes}) ` +
      `but the BIN chunk is only ${bin.byteLength} bytes`,
    );
  }

  // If data is tightly packed, we can use a view directly
  if (byteStride === elementSize) {
    const byteLength = accessor.count * elementSize;
    const slice = bin.slice(bufferOffset, bufferOffset + byteLength);

    switch (accessor.componentType) {
      case COMPONENT_FLOAT:
        return new Float32Array(slice.buffer, slice.byteOffset, accessor.count * componentCount);
      case COMPONENT_UNSIGNED_INT:
        return new Uint32Array(slice.buffer, slice.byteOffset, accessor.count * componentCount);
      case COMPONENT_UNSIGNED_SHORT:
        return new Uint16Array(slice.buffer, slice.byteOffset, accessor.count * componentCount);
      case COMPONENT_UNSIGNED_BYTE:
        return slice;
      default:
        throw new Error(`Unsupported component type for reading: ${accessor.componentType}`);
    }
  }

  // Handle strided data
  const result =
    accessor.componentType === COMPONENT_FLOAT
      ? new Float32Array(accessor.count * componentCount)
      : accessor.componentType === COMPONENT_UNSIGNED_INT
        ? new Uint32Array(accessor.count * componentCount)
        : accessor.componentType === COMPONENT_UNSIGNED_SHORT
          ? new Uint16Array(accessor.count * componentCount)
          : new Uint8Array(accessor.count * componentCount);

  const dataView = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);

  for (let i = 0; i < accessor.count; i++) {
    const elementOffset = bufferOffset + i * byteStride;
    for (let c = 0; c < componentCount; c++) {
      const byteOffset = elementOffset + c * componentSize;
      let value: number;

      switch (accessor.componentType) {
        case COMPONENT_FLOAT:
          value = dataView.getFloat32(byteOffset, true);
          break;
        case COMPONENT_UNSIGNED_INT:
          value = dataView.getUint32(byteOffset, true);
          break;
        case COMPONENT_UNSIGNED_SHORT:
          value = dataView.getUint16(byteOffset, true);
          break;
        case COMPONENT_UNSIGNED_BYTE:
          value = dataView.getUint8(byteOffset);
          break;
        default:
          throw new Error(`Unsupported component type: ${accessor.componentType}`);
      }

      result[i * componentCount + c] = value;
    }
  }

  return result;
}

