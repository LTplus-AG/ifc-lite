/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A minimal writer for tiled, uncompressed Float32 GeoTIFFs with internal
 * overviews: the same layout as the swissALTI3D COGs (tiled, one band,
 * EPSG:2056, PixelIsArea, GDAL_NODATA, reduced-resolution IFDs after the
 * full image), small enough to build per test. geotiff's own
 * `writeArrayBuffer` only writes stripped single-image files.
 */

export interface GeoTiffLevel {
  width: number;
  height: number;
  /** Row-major values. */
  values: Float32Array;
}

export interface TiledGeoTiffSpec {
  /** Full resolution first, then overviews. */
  levels: GeoTiffLevel[];
  tileSize: number;
  originX: number;
  originY: number;
  pixelSize: number;
  noData: number;
  epsg: number;
}

const SHORT = 3;
const LONG = 4;
const DOUBLE = 12;
const ASCII = 2;
const TYPE_SIZE: Record<number, number> = { [SHORT]: 2, [LONG]: 4, [DOUBLE]: 8, [ASCII]: 1 };

interface Entry {
  tag: number;
  type: number;
  values: number[] | string;
}

class Writer {
  private buf = new Uint8Array(1 << 16);
  private view = new DataView(this.buf.buffer);
  length = 0;

  private ensure(n: number): void {
    if (this.length + n <= this.buf.length) return;
    let size = this.buf.length;
    while (size < this.length + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf);
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): void {
    this.ensure(1);
    this.view.setUint8(this.length, v);
    this.length += 1;
  }
  u16(v: number): void {
    this.ensure(2);
    this.view.setUint16(this.length, v, true);
    this.length += 2;
  }
  u32(v: number): void {
    this.ensure(4);
    this.view.setUint32(this.length, v, true);
    this.length += 4;
  }
  f32(v: number): void {
    this.ensure(4);
    this.view.setFloat32(this.length, v, true);
    this.length += 4;
  }
  f64(v: number): void {
    this.ensure(8);
    this.view.setFloat64(this.length, v, true);
    this.length += 8;
  }
  patchU32(at: number, v: number): void {
    this.view.setUint32(at, v, true);
  }
  align(): void {
    if (this.length % 2) this.u8(0);
  }
  bytes(): ArrayBuffer {
    return this.buf.slice(0, this.length).buffer;
  }
}

function writeValue(w: Writer, type: number, v: number): void {
  if (type === SHORT) w.u16(v);
  else if (type === LONG) w.u32(v);
  else if (type === DOUBLE) w.f64(v);
  else w.u8(v);
}

/** Write one IFD at the current position; returns the offset of its next-IFD pointer. */
function writeIfd(w: Writer, entries: Entry[]): number {
  entries.sort((a, b) => a.tag - b.tag);
  const asNumbers = (e: Entry): number[] =>
    typeof e.values === 'string' ? [...e.values].map((c) => c.charCodeAt(0)).concat(0) : e.values;
  const start = w.length;
  const tableSize = 2 + entries.length * 12 + 4;
  let extraAt = start + tableSize;
  const extras: Array<{ type: number; values: number[] }> = [];
  w.u16(entries.length);
  for (const e of entries) {
    const vals = asNumbers(e);
    const size = TYPE_SIZE[e.type] * vals.length;
    w.u16(e.tag);
    w.u16(e.type);
    w.u32(vals.length);
    if (size <= 4) {
      const before = w.length;
      for (const v of vals) writeValue(w, e.type, v);
      while (w.length < before + 4) w.u8(0);
    } else {
      w.u32(extraAt);
      extras.push({ type: e.type, values: vals });
      extraAt += size + (size % 2);
    }
  }
  const nextPtr = w.length;
  w.u32(0);
  for (const x of extras) {
    for (const v of x.values) writeValue(w, x.type, v);
    w.align();
  }
  return nextPtr;
}

export function writeTiledGeoTiff(spec: TiledGeoTiffSpec): ArrayBuffer {
  const w = new Writer();
  w.u8(0x49);
  w.u8(0x49);
  w.u16(42);
  const firstIfdPtr = w.length;
  w.u32(0);

  const T = spec.tileSize;
  const tileOffsets: number[][] = [];
  for (const level of spec.levels) {
    const offsets: number[] = [];
    const across = Math.ceil(level.width / T);
    const down = Math.ceil(level.height / T);
    for (let ty = 0; ty < down; ty++) {
      for (let tx = 0; tx < across; tx++) {
        offsets.push(w.length);
        for (let r = 0; r < T; r++) {
          for (let c = 0; c < T; c++) {
            const x = tx * T + c;
            const y = ty * T + r;
            w.f32(x < level.width && y < level.height ? level.values[y * level.width + x] : spec.noData);
          }
        }
      }
    }
    tileOffsets.push(offsets);
  }

  let prevPtr = firstIfdPtr;
  spec.levels.forEach((level, i) => {
    w.align();
    w.patchU32(prevPtr, w.length);
    const n = tileOffsets[i].length;
    const entries: Entry[] = [
      { tag: 254, type: LONG, values: [i === 0 ? 0 : 1] },
      { tag: 256, type: LONG, values: [level.width] },
      { tag: 257, type: LONG, values: [level.height] },
      { tag: 258, type: SHORT, values: [32] },
      { tag: 259, type: SHORT, values: [1] },
      { tag: 262, type: SHORT, values: [1] },
      { tag: 277, type: SHORT, values: [1] },
      { tag: 284, type: SHORT, values: [1] },
      { tag: 322, type: SHORT, values: [T] },
      { tag: 323, type: SHORT, values: [T] },
      { tag: 324, type: LONG, values: tileOffsets[i] },
      { tag: 325, type: LONG, values: new Array<number>(n).fill(T * T * 4) },
      { tag: 339, type: SHORT, values: [3] },
    ];
    if (i === 0) {
      entries.push(
        { tag: 33550, type: DOUBLE, values: [spec.pixelSize, spec.pixelSize, 0] },
        { tag: 33922, type: DOUBLE, values: [0, 0, 0, spec.originX, spec.originY, 0] },
        // GeoKeyDirectory: projected model, PixelIsArea, ProjectedCSType = epsg.
        { tag: 34735, type: SHORT, values: [1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, spec.epsg] },
        { tag: 42113, type: ASCII, values: String(spec.noData) },
      );
    }
    prevPtr = writeIfd(w, entries);
  });
  return w.bytes();
}
