/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IFC GUID (IfcGloballyUniqueId) conversion utilities.
 *
 * IFC uses a 22-character base64 encoding of a 128-bit UUID using the custom
 * buildingSMART alphabet. This module owns the canonical encode/decode and
 * validation logic for that representation across the repo.
 */

const IFC_GUID_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';

const IFC_GUID_CHAR_TO_VALUE: Record<string, number> = {};
for (let i = 0; i < IFC_GUID_CHARS.length; i++) {
  IFC_GUID_CHAR_TO_VALUE[IFC_GUID_CHARS[i]] = i;
}

export function uuidToIfcGuid(uuid: string): string {
  const hex = uuid.replace(/-/g, '').toUpperCase();
  if (hex.length !== 32) {
    throw new Error(`Invalid UUID: expected 32 hex characters, got ${hex.length}`);
  }
  if (!/^[0-9A-F]{32}$/.test(hex)) {
    // The length check alone lets a non-hex character (e.g. 'g', 'z', '_')
    // through: parseInt(..., 16) below would silently return NaN for that
    // byte, and Uint8Array coerces NaN to 0 - turning garbage input into a
    // wrong-but-valid-looking GUID instead of rejecting it.
    throw new Error(`Invalid UUID: contains non-hexadecimal characters`);
  }

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }

  let result = '';
  result += IFC_GUID_CHARS[(bytes[0] >> 6) & 0x03];
  result += IFC_GUID_CHARS[bytes[0] & 0x3F];

  for (let i = 1; i < 16; i += 3) {
    const b0 = bytes[i] || 0;
    const b1 = bytes[i + 1] || 0;
    const b2 = bytes[i + 2] || 0;

    result += IFC_GUID_CHARS[(b0 >> 2) & 0x3F];
    result += IFC_GUID_CHARS[((b0 & 0x03) << 4) | ((b1 >> 4) & 0x0F)];
    result += IFC_GUID_CHARS[((b1 & 0x0F) << 2) | ((b2 >> 6) & 0x03)];
    result += IFC_GUID_CHARS[b2 & 0x3F];
  }

  return result;
}

export function ifcGuidToUuid(ifcGuid: string): string {
  if (ifcGuid.length !== 22) {
    throw new Error(`Invalid IFC GUID: expected 22 characters, got ${ifcGuid.length}`);
  }

  const values: number[] = [];
  for (const char of ifcGuid) {
    const value = IFC_GUID_CHAR_TO_VALUE[char];
    if (value === undefined) {
      throw new Error(`Invalid IFC GUID character: ${char}`);
    }
    values.push(value);
  }

  const bytes = new Uint8Array(16);
  bytes[0] = ((values[0] & 0x03) << 6) | (values[1] & 0x3F);

  let byteIndex = 1;
  for (let i = 2; i < 22; i += 4) {
    const v0 = values[i];
    const v1 = values[i + 1];
    const v2 = values[i + 2];
    const v3 = values[i + 3];

    bytes[byteIndex++] = ((v0 & 0x3F) << 2) | ((v1 >> 4) & 0x03);
    bytes[byteIndex++] = ((v1 & 0x0F) << 4) | ((v2 >> 2) & 0x0F);
    bytes[byteIndex++] = ((v2 & 0x03) << 6) | (v3 & 0x3F);
  }

  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }

  return `${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20, 32)}`.toLowerCase();
}

/**
 * Optional randomness source for GUID generation: a `Math.random`-style
 * function returning floats in `[0, 1)`. Pass a seeded generator to make GUID
 * generation reproducible (e.g. for byte-deterministic file output); omit it
 * to use Web Crypto when the runtime provides it, falling back to
 * `Math.random` when it does not. A seeded source trades global uniqueness
 * for reproducibility - only use one where that is the point.
 */
export type RandomSource = () => number;

export function generateIfcGuid(random?: RandomSource): string {
  return uuidToIfcGuid(generateUuid(random));
}

export function generateUuid(random?: RandomSource): string {
  if (random === undefined && typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (random !== undefined) {
    for (let i = 0; i < 16; i++) {
      bytes[i] = Math.floor(random() * 256) & 0xff;
    }
  } else if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }

  bytes[6] = (bytes[6] & 0x0F) | 0x40;
  bytes[8] = (bytes[8] & 0x3F) | 0x80;

  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }

  return `${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20, 32)}`;
}

export function isValidIfcGuid(ifcGuid: string): boolean {
  if (typeof ifcGuid !== 'string' || ifcGuid.length !== 22) {
    return false;
  }

  const firstCharValue = IFC_GUID_CHAR_TO_VALUE[ifcGuid[0]];
  if (firstCharValue === undefined || firstCharValue > 3) {
    return false;
  }

  for (let i = 1; i < ifcGuid.length; i++) {
    if (IFC_GUID_CHAR_TO_VALUE[ifcGuid[i]] === undefined) {
      return false;
    }
  }

  return true;
}

export function isValidUuid(uuid: string): boolean {
  if (typeof uuid !== 'string') {
    return false;
  }

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}
