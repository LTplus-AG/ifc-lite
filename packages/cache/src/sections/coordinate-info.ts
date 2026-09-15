/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { AABB, CoordinateInfo, Vec3 } from '@ifc-lite/geometry';
import { BufferReader, BufferWriter } from '../utils/buffer-utils.js';

export function writeCoordinateInfo(writer: BufferWriter, info: CoordinateInfo): void {
  writeVec3(writer, info.originShift);
  writeAABB(writer, info.originalBounds);
  writeAABB(writer, info.shiftedBounds);
  writer.writeUint8(info.hasLargeCoordinates ? 1 : 0);

  const hasWasmRtc = info.wasmRtcOffset !== undefined;
  writer.writeUint8(hasWasmRtc ? 1 : 0);
  if (hasWasmRtc) writeVec3(writer, info.wasmRtcOffset!);

  const hasBuildingRotation = info.buildingRotation !== undefined;
  writer.writeUint8(hasBuildingRotation ? 1 : 0);
  if (hasBuildingRotation) writer.writeFloat64(info.buildingRotation!);

  // Version 20+: exact WASM RTC producer provenance. This is distinct from
  // wasmRtcOffset: false is authoritative, and true with a zero frame matters.
  const hasWasmRtcFrame = info.wasmRtcFrame !== undefined;
  writer.writeUint8(hasWasmRtcFrame ? 1 : 0);
  if (hasWasmRtcFrame) {
    const frame = info.wasmRtcFrame!;
    validateWasmRtcFrame(frame, info.wasmRtcOffset);
    writeVec3(writer, frame);
    writer.writeUint8(frame.needsShift ? 1 : 0);
  }
}

function validateWasmRtcFrame(
  frame: CoordinateInfo['wasmRtcFrame'] & {},
  rtcOffset: Vec3 | undefined,
): void {
  if (![frame.x, frame.y, frame.z].every(Number.isFinite)) {
    throw new Error('Invalid wasmRtcFrame: every component must be finite');
  }
  if (typeof frame.needsShift !== 'boolean') {
    throw new Error('Invalid wasmRtcFrame: needsShift must be a boolean');
  }
  if (rtcOffset) validateFiniteRtcOffset(rtcOffset);
  if (frame.needsShift !== (rtcOffset !== undefined)) {
    throw new Error('Invalid wasmRtcFrame: needsShift disagrees with wasmRtcOffset presence');
  }
  if (frame.needsShift && rtcOffset && !(
    Object.is(frame.x, rtcOffset.x)
    && Object.is(frame.y, rtcOffset.y)
    && Object.is(frame.z, rtcOffset.z)
  )) {
    throw new Error('Invalid wasmRtcFrame: active components disagree with wasmRtcOffset');
  }
}

function validateFiniteRtcOffset(rtcOffset: Vec3): void {
  if (![rtcOffset.x, rtcOffset.y, rtcOffset.z].every(Number.isFinite)) {
    throw new Error('Invalid wasmRtcOffset: every component must be finite');
  }
}

export function readCoordinateInfo(reader: BufferReader, version: number = 2): CoordinateInfo {
  const originShift = readVec3(reader);
  const originalBounds = readAABB(reader);
  const shiftedBounds = readAABB(reader);
  const hasLargeCoordinates = reader.readUint8() === 1;
  let wasmRtcOffset: Vec3 | undefined;
  let buildingRotation: number | undefined;
  let wasmRtcFrame: CoordinateInfo['wasmRtcFrame'];

  if (version >= 3) {
    if (reader.readUint8() === 1) wasmRtcOffset = readVec3(reader);
    if (reader.readUint8() === 1) buildingRotation = reader.readFloat64();
  }

  if (version >= 20) {
    const hasFrame = reader.readUint8();
    if (hasFrame !== 0 && hasFrame !== 1) {
      throw new Error(`Invalid wasmRtcFrame presence flag: ${hasFrame}`);
    }
    if (hasFrame === 1) {
      const frame = readVec3(reader);
      const needsShift = reader.readUint8();
      if (needsShift !== 0 && needsShift !== 1) {
        throw new Error(`Invalid wasmRtcFrame needsShift flag: ${needsShift}`);
      }
      wasmRtcFrame = { ...frame, needsShift: needsShift === 1 };
      validateWasmRtcFrame(wasmRtcFrame, wasmRtcOffset);
    }
  }

  return {
    originShift,
    originalBounds,
    shiftedBounds,
    hasLargeCoordinates,
    wasmRtcOffset,
    wasmRtcFrame,
    buildingRotation,
  };
}

function writeVec3(writer: BufferWriter, value: Vec3): void {
  writer.writeFloat64(value.x);
  writer.writeFloat64(value.y);
  writer.writeFloat64(value.z);
}

function writeAABB(writer: BufferWriter, value: AABB): void {
  writeVec3(writer, value.min);
  writeVec3(writer, value.max);
}

function readVec3(reader: BufferReader): Vec3 {
  return { x: reader.readFloat64(), y: reader.readFloat64(), z: reader.readFloat64() };
}

function readAABB(reader: BufferReader): AABB {
  return { min: readVec3(reader), max: readVec3(reader) };
}
