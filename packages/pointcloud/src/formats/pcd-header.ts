/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export interface PcdField {
  name: string;
  size: number;       // bytes per element (1, 2, 4, 8)
  type: 'F' | 'I' | 'U';
  count: number;      // elements per record (typically 1)
  offset: number;     // byte offset within a row-major record
}

export interface PcdHeader {
  version: string;
  fields: PcdField[];
  width: number;
  height: number;
  pointCount: number;
  pointStride: number;
  data: 'ascii' | 'binary' | 'binary_compressed';
  bodyOffset: number;
}

const TEXT_DECODER = new TextDecoder();

export function parseHeader(buffer: Uint8Array): PcdHeader {
  // Header is ASCII, terminated by the line beginning with "DATA ".
  // 64 KB covers files with long comments / metadata while still bounding
  // the worst-case scan; larger headers are unrealistic in practice and
  // rejecting them is preferable to scanning a multi-GB body.
  const probeLen = Math.min(65536, buffer.length);
  const probe = TEXT_DECODER.decode(buffer.subarray(0, probeLen));

  const dataIdx = probe.search(/^DATA\s+(\S+)/m);
  if (dataIdx < 0) {
    throw new Error('PCD: missing DATA line in header (scanned first ' + probeLen + ' bytes)');
  }
  const headerText = probe.slice(0, dataIdx);
  const dataLineMatch = probe.slice(dataIdx).match(/^DATA[ \t]+(\S+)[ \t\r]*\n/);
  if (!dataLineMatch) {
    throw new Error('PCD: malformed DATA line');
  }
  const dataKind = dataLineMatch[1].toLowerCase();
  if (dataKind !== 'ascii' && dataKind !== 'binary' && dataKind !== 'binary_compressed') {
    throw new Error(`PCD: unsupported DATA kind "${dataKind}"`);
  }
  const bodyOffset = dataIdx + dataLineMatch[0].length;

  // Parse named tokens out of the header.
  const tokens = new Map<string, string[]>();
  for (const rawLine of headerText.split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const key = parts[0].toUpperCase();
    tokens.set(key, parts.slice(1));
  }

  const fieldNames = tokens.get('FIELDS') ?? [];
  const sizes = (tokens.get('SIZE') ?? []).map(Number);
  const types = (tokens.get('TYPE') ?? []) as Array<'F' | 'I' | 'U'>;
  const counts = (tokens.get('COUNT') ?? []).map(Number);
  const widthRaw = tokens.get('WIDTH')?.[0];
  const heightRaw = tokens.get('HEIGHT')?.[0];
  const pointsRaw = tokens.get('POINTS')?.[0];

  if (fieldNames.length === 0) throw new Error('PCD: missing FIELDS');
  if (sizes.length !== fieldNames.length) throw new Error('PCD: SIZE/FIELDS length mismatch');
  if (types.length !== fieldNames.length) throw new Error('PCD: TYPE/FIELDS length mismatch');

  const fields: PcdField[] = [];
  let stride = 0;
  for (let i = 0; i < fieldNames.length; i++) {
    const count = counts[i] ?? 1;
    const size = sizes[i];
    const type = types[i];
    if (type !== 'F' && type !== 'I' && type !== 'U') {
      throw new Error(`PCD: unsupported field TYPE "${type}"`);
    }
    // SIZE/COUNT feed offset and stride arithmetic that every subsequent read
    // trusts: fractional, zero, negative, or absurd values must be rejected
    // here rather than surface as NaN offsets or a poisoned stride.
    if (
      !Number.isSafeInteger(size) || size <= 0 ||
      !Number.isSafeInteger(count) || count <= 0 ||
      !Number.isSafeInteger(size * count)
    ) {
      throw new Error(`PCD: invalid field SIZE or COUNT (size=${size}, count=${count})`);
    }
    fields.push({ name: fieldNames[i], size, type, count, offset: stride });
    stride += size * count;
    if (!Number.isSafeInteger(stride)) {
      throw new Error('PCD: field stride overflow');
    }
  }

  const width = widthRaw !== undefined ? parseInt(widthRaw, 10) : 0;
  const height = heightRaw !== undefined ? parseInt(heightRaw, 10) : 1;
  const pointCount = pointsRaw !== undefined ? parseInt(pointsRaw, 10) : width * height;
  if (!Number.isFinite(pointCount) || pointCount <= 0) {
    throw new Error('PCD: invalid point count');
  }

  return {
    version: tokens.get('VERSION')?.[0] ?? '0.7',
    fields,
    width,
    height,
    pointCount,
    pointStride: stride,
    data: dataKind as PcdHeader['data'],
    bodyOffset,
  };
}
