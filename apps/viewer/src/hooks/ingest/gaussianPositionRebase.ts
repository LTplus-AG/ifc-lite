// SPDX-License-Identifier: MPL-2.0

/** Read admitted PLY centres directly from the binary records. The upstream
 * materialized table stores every scalar as f32, including PLY doubles. */
const WIDTH: Record<string, number> = { char: 1, uchar: 1, short: 2, ushort: 2, int: 4, uint: 4, float: 4, double: 8 };
type Column = { name: string; data: ArrayLike<number> };
type Bounds = { min: [number, number, number]; max: [number, number, number] };

export function rebaseGaussianPositions(bytes: Uint8Array, format: 'gaussian-ply' | 'splat', count: number,
  stride: number, columns: readonly Column[]): { origin: [number, number, number]; bounds: Bounds } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const positions = ['x', 'y', 'z'].map(name => columns.find(column => column.name === name)?.data);
  if (positions.some(column => !column || column.length !== count)) throw new Error('Missing Gaussian position channel.');
  let base = 0;
  let little = true;
  let fields: { offset: number; type: string }[] = [];
  if (format === 'gaussian-ply') {
    const header = new TextDecoder('ascii').decode(bytes.subarray(0, Math.min(bytes.length, 65_536)));
    const marker = header.indexOf('\nend_header\n');
    if (marker < 0) throw new Error('Missing Gaussian PLY header end.');
    base = marker + '\nend_header\n'.length;
    const formatLine = header.slice(0, base).split('\n').map(line => line.split(' ').filter(Boolean))
      .find(parts => parts[0] === 'format');
    if (formatLine?.[1] !== 'binary_little_endian' && formatLine?.[1] !== 'binary_big_endian') {
      throw new Error('Unsupported Gaussian PLY encoding.');
    }
    little = formatLine[1] === 'binary_little_endian';
    let vertex = false, offset = 0;
    for (const line of header.slice(0, base).split('\n')) {
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
  }
  const read = (row: number, axis: number): number => {
    if (format === 'splat') return positions[axis]![row]; // .splat is f32 on disk.
    const { offset, type } = fields[axis];
    if (type !== 'double') return positions[axis]![row]; // Preserve the upstream scalar decoding for non-double PLY.
    const at = base + row * stride + offset;
    return view.getFloat64(at, little);
  };
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let row = 0; row < count; row++) for (let axis = 0; axis < 3; axis++) {
    const value = read(row, axis);
    if (!Number.isFinite(value)) throw new Error('Non-finite decoded Gaussian channel: position.');
    min[axis] = Math.min(min[axis], value);
    max[axis] = Math.max(max[axis], value);
  }
  const origin = min.map((value, axis) => value / 2 + max[axis] / 2) as [number, number, number];
  for (let axis = 0; axis < 3; axis++) {
    const target = positions[axis] as Float32Array;
    for (let row = 0; row < count; row++) target[row] = read(row, axis) - origin[axis];
  }
  return { origin, bounds: { min, max } };
}
