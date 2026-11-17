/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
export type PlyColumns = Readonly<Record<string, Float32Array | Float64Array | Uint8Array | Uint16Array>>;
const type = (values: PlyColumns[string]) => values instanceof Float64Array ? 'double'
  : values instanceof Float32Array ? 'float' : values instanceof Uint16Array ? 'ushort' : 'uchar';

/** Bounded browser Blob export: never silently decimate to fit the limit. */
export class PositionedPly {
  static readonly maxBytes = 256 * 1024 * 1024;
  private parts: ArrayBuffer[] = [];
  private schema: { name: string; type: string; width: number }[] | undefined;
  private bytes = 0;
  private count = 0;

  add(columns: PlyColumns): void {
    const entries = Object.entries(columns);
    const count = columns.x?.length;
    if (count === undefined || !columns.y || !columns.z || entries.some(([, values]) => values.length !== count)) throw new Error('Inconsistent PLY columns.');
    const schema = entries.map(([name, values]) => ({ name, type: type(values), width: values.BYTES_PER_ELEMENT }));
    if (schema.some(field => !/^[a-z][a-z0-9_]*$/.test(field.name))) throw new Error('Invalid PLY property name.');
    if (this.schema && JSON.stringify(this.schema) !== JSON.stringify(schema)) throw new Error('Scan attributes changed between chunks; export refused.');
    const stride = schema.reduce((sum, field) => sum + field.width, 0);
    if (this.bytes + count * stride > PositionedPly.maxBytes - 65536) throw new Error('Positioned PLY exceeds the 256 MiB browser export limit. No partial file was downloaded.');
    const buffer = new ArrayBuffer(count * stride);
    const view = new DataView(buffer);
    let offset = 0;
    for (let row = 0; row < count; row++) for (const [name, values] of entries) {
      const value = values[row];
      if (!Number.isFinite(value)) throw new Error(`Non-finite PLY value in ${name}.`);
      if (values instanceof Float64Array) view.setFloat64(offset, value, true);
      else if (values instanceof Float32Array) view.setFloat32(offset, value, true);
      else if (values instanceof Uint16Array) view.setUint16(offset, value, true);
      else view.setUint8(offset, value);
      offset += values.BYTES_PER_ELEMENT;
    }
    this.schema = schema;
    this.parts.push(buffer);
    this.bytes += buffer.byteLength;
    this.count += count;
  }

  finish(): Blob {
    if (!this.schema || !this.count) throw new Error('The source contains no exportable points.');
    const header = ['ply', 'format binary_little_endian 1.0', 'comment IFC-Lite positioned export; project coordinates; Z up',
      `element vertex ${this.count}`, ...this.schema.map(field => `property ${field.type} ${field.name}`), 'end_header', ''].join('\n');
    return new Blob([header, ...this.parts], { type: 'application/octet-stream' });
  }
}
