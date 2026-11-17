// SPDX-License-Identifier: MPL-2.0

/** Read admitted PLY centres directly from the binary records. The upstream
 * materialized table stores every scalar as f32, including PLY doubles. */
const WIDTH: Record<string, number> = { char: 1, uchar: 1, short: 2, ushort: 2, int: 4, uint: 4, float: 4, double: 8 };
type Column = { name: string; data: ArrayLike<number> };
type Bounds = { min: [number, number, number]; max: [number, number, number] };

/** Where a capture's records start and how its centres are stored. */
export interface GaussianPositionLayout {
  /** Byte offset of the first record. */
  readonly base: number;
  readonly stride: number;
  readonly little: boolean;
  /** Per axis: byte offset in the record and PLY type; empty for `.splat` (f32 on disk). */
  readonly fields: readonly { offset: number; type: string }[];
  /** Any centre stored as a double, so it must be read from the record bytes, not the f32 table. */
  readonly needsRecords: boolean;
}

/** Parse the centre layout from the header bytes (the first <=64 KiB of the file). */
export function gaussianPositionLayout(header: Uint8Array, format: 'gaussian-ply' | 'splat', stride: number): GaussianPositionLayout {
  if (format === 'splat') return { base: 0, stride, little: true, fields: [], needsRecords: false };
  const text = new TextDecoder('ascii').decode(header.subarray(0, Math.min(header.length, 65_536)));
  const marker = text.indexOf('\nend_header\n');
  if (marker < 0) throw new Error('Missing Gaussian PLY header end.');
  const base = marker + '\nend_header\n'.length;
  const formatLine = text.slice(0, base).split('\n').map(line => line.split(' ').filter(Boolean))
    .find(parts => parts[0] === 'format');
  if (formatLine?.[1] !== 'binary_little_endian' && formatLine?.[1] !== 'binary_big_endian') {
    throw new Error('Unsupported Gaussian PLY encoding.');
  }
  const little = formatLine[1] === 'binary_little_endian';
  const fields: { offset: number; type: string }[] = [];
  let vertex = false, offset = 0;
  for (const line of text.slice(0, base).split('\n')) {
    const parts = line.split(' ').filter(Boolean);
    if (parts[0] === 'element') vertex = parts[1] === 'vertex';
    if (parts[0] !== 'property' || !vertex) continue;
    const width = WIDTH[parts[1]];
    if (!width) throw new Error('Unsupported Gaussian PLY position layout.');
    const axis = ['x', 'y', 'z'].indexOf(parts[2]);
    if (axis >= 0) fields[axis] = { offset, type: parts[1] };
    offset += width;
  }
  if (offset !== stride || fields.length !== 3 || fields.some(field => !field)) throw new Error('Inconsistent Gaussian PLY layout.');
  return { base, stride, little, fields, needsRecords: fields.some(field => field.type === 'double') };
}

/**
 * Source-space centre reader for `count` rows. `records` holds those rows' bytes
 * (from the first of them) when the layout `needsRecords`; otherwise the decoded
 * f32 columns are the source values, as upstream decoded them.
 */
export function gaussianSourcePositions(layout: GaussianPositionLayout, count: number, columns: readonly Column[], records?: Uint8Array) {
  const positions = ['x', 'y', 'z'].map(name => columns.find(column => column.name === name)?.data);
  if (positions.some(column => !column || column.length !== count)) throw new Error('Missing Gaussian position channel.');
  if (layout.needsRecords && (!records || records.byteLength < count * layout.stride)) throw new Error('Missing Gaussian position records.');
  const view = records ? new DataView(records.buffer, records.byteOffset, records.byteLength) : null;
  return (row: number, axis: number): number => {
    const field = layout.fields[axis];
    if (!field || field.type !== 'double') return positions[axis]![row]; // Preserve the upstream scalar decoding for non-double PLY.
    return view!.getFloat64(row * layout.stride + field.offset, layout.little);
  };
}

/** Grow `bounds` by `count` source centres, rejecting non-finite ones. */
export function accumulateGaussianBounds(read: (row: number, axis: number) => number, count: number, bounds: Bounds): void {
  for (let row = 0; row < count; row++) for (let axis = 0; axis < 3; axis++) {
    const value = read(row, axis);
    if (!Number.isFinite(value)) throw new Error('Non-finite decoded Gaussian channel: position.');
    if (value < bounds.min[axis]) bounds.min[axis] = value;
    if (value > bounds.max[axis]) bounds.max[axis] = value;
  }
}

export const emptyGaussianBounds = (): Bounds => ({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
export const gaussianBoundsOrigin = (bounds: Bounds): [number, number, number] =>
  bounds.min.map((value, axis) => value / 2 + bounds.max[axis] / 2) as [number, number, number];

/** Overwrite the f32 position columns with source centres minus `origin` (narrowed after the f64 subtraction). */
export function writeRebasedPositions(read: (row: number, axis: number) => number, count: number, columns: readonly Column[], origin: readonly [number, number, number]): void {
  const targets = ['x', 'y', 'z'].map(name => columns.find(column => column.name === name)!.data as Float32Array);
  for (let axis = 0; axis < 3; axis++) {
    const target = targets[axis];
    for (let row = 0; row < count; row++) target[row] = read(row, axis) - origin[axis];
  }
}

export function rebaseGaussianPositions(bytes: Uint8Array, format: 'gaussian-ply' | 'splat', count: number,
  stride: number, columns: readonly Column[]): { origin: [number, number, number]; bounds: Bounds } {
  const layout = gaussianPositionLayout(bytes, format, stride);
  const read = gaussianSourcePositions(layout, count, columns, layout.needsRecords ? bytes.subarray(layout.base) : undefined);
  const bounds = emptyGaussianBounds();
  accumulateGaussianBounds(read, count, bounds);
  const origin = gaussianBoundsOrigin(bounds);
  writeRebasedPositions(read, count, columns, origin);
  return { origin, bounds };
}
