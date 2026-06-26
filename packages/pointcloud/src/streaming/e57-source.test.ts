/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { E57StreamingSource } from './e57-source.js';
import { decodeE57 } from '../formats/e57.js';
import { logicalToPhysical, physicalToLogical } from '../formats/e57-page.js';
import type { DecodedPointChunk } from '../types.js';

const enc = new TextEncoder();

interface TestPoint {
  x: number; y: number; z: number;
  r?: number; g?: number; b?: number;
}

/**
 * Build the logical byte stream for one or more DataPackets carrying
 * `points`, split into groups of `pointsPerPacket`. cartesianX/Y/Z are
 * Float single; colours (when present on the first point) are Integer u8.
 */
function buildDataPackets(points: TestPoint[], pointsPerPacket: number): Uint8Array {
  const hasColor = points.length > 0 && points[0].r !== undefined;
  const nStreams = hasColor ? 6 : 3;
  const groups: Uint8Array[] = [];
  for (let start = 0; start < points.length; start += pointsPerPacket) {
    const group = points.slice(start, start + pointsPerPacket);
    const k = group.length;
    const lenF = k * 4;
    const lenU8 = k * 1;
    const lengths = hasColor ? [lenF, lenF, lenF, lenU8, lenU8, lenU8] : [lenF, lenF, lenF];
    const totalPayload = lengths.reduce((a, b) => a + b, 0);
    const headerBytes = 4 + 2 + nStreams * 2;
    const packetSize = headerBytes + totalPayload;
    const buf = new ArrayBuffer(packetSize);
    const view = new DataView(buf);
    view.setUint8(0, 1);                       // packetType = data
    view.setUint8(1, 0);                       // flags
    view.setUint16(2, packetSize - 1, true);   // packetLogicalLength - 1
    view.setUint16(4, nStreams, true);         // bytestreamCount
    for (let i = 0; i < nStreams; i++) view.setUint16(6 + i * 2, lengths[i], true);
    let cursor = headerBytes;
    for (let i = 0; i < k; i++) view.setFloat32(cursor + i * 4, group[i].x, true);
    cursor += lenF;
    for (let i = 0; i < k; i++) view.setFloat32(cursor + i * 4, group[i].y, true);
    cursor += lenF;
    for (let i = 0; i < k; i++) view.setFloat32(cursor + i * 4, group[i].z, true);
    cursor += lenF;
    if (hasColor) {
      for (let i = 0; i < k; i++) view.setUint8(cursor + i, group[i].r ?? 0);
      cursor += lenU8;
      for (let i = 0; i < k; i++) view.setUint8(cursor + i, group[i].g ?? 0);
      cursor += lenU8;
      for (let i = 0; i < k; i++) view.setUint8(cursor + i, group[i].b ?? 0);
    }
    groups.push(new Uint8Array(buf));
  }
  const total = groups.reduce((a, g) => a + g.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const g of groups) { out.set(g, off); off += g.length; }
  return out;
}

/** Inflate a logical byte stream into the physical (CRC-paged) form —
 *  the exact inverse of `stripPageCrc`. CRC tails are left zeroed (the
 *  decoder never validates them). */
function inflateToPhysical(logical: Uint8Array, pageSize: number): Uint8Array {
  const payloadPerPage = pageSize - 4;
  const fullPages = Math.floor(logical.length / payloadPerPage);
  const tail = logical.length - fullPages * payloadPerPage;
  const physLen = fullPages * pageSize + (tail > 0 ? tail + 4 : 0);
  const out = new Uint8Array(physLen);
  for (let p = 0; p < fullPages; p++) {
    out.set(logical.subarray(p * payloadPerPage, (p + 1) * payloadPerPage), p * pageSize);
  }
  if (tail > 0) out.set(logical.subarray(fullPages * payloadPerPage), fullPages * pageSize);
  return out;
}

/** Build a complete, CRC-paged single-scan E57 file as a Blob. */
function buildE57(
  points: TestPoint[],
  opts: { pageSize?: number; pointsPerPacket?: number; emptyData3D?: boolean } = {},
): {
  blob: Blob;
  physical: Uint8Array;
} {
  const pageSize = opts.pageSize ?? 256;
  const hasColor = points.length > 0 && points[0].r !== undefined;
  const packets = buildDataPackets(points, opts.pointsPerPacket ?? 8);

  // Logical layout: [header 48][pad to 64][section 32][data][xml].
  const sectionLogicalOffset = 64;
  const dataLogicalOffset = sectionLogicalOffset + 32;
  const xmlLogicalOffset = dataLogicalOffset + packets.length;

  const colorProto = hasColor
    ? `<colorRed type="Integer" minimum="0" maximum="255"/>`
      + `<colorGreen type="Integer" minimum="0" maximum="255"/>`
      + `<colorBlue type="Integer" minimum="0" maximum="255"/>`
    : '';
  const xml = `<?xml version="1.0" encoding="UTF-8"?>`
    + `<e57Root type="Structure">`
    + `<data3D type="Vector">`
    + (opts.emptyData3D ? '' : `<vectorChild type="Structure">`
      + `<guid type="String">{scan-1}</guid>`
      + `<points type="CompressedVector" fileOffset="${logicalToPhysical(sectionLogicalOffset, pageSize)}" recordCount="${points.length}">`
      + `<prototype type="Structure">`
      + `<cartesianX type="Float" precision="single"/>`
      + `<cartesianY type="Float" precision="single"/>`
      + `<cartesianZ type="Float" precision="single"/>`
      + colorProto
      + `</prototype>`
      + `</points>`
      + `</vectorChild>`)
    + `</data3D>`
    + `</e57Root>`;
  const xmlBytes = enc.encode(xml);

  const logicalLen = xmlLogicalOffset + xmlBytes.length;
  const logical = new Uint8Array(logicalLen);

  // FileHeader (48 bytes).
  logical.set(enc.encode('ASTM-E57'), 0);
  const hv = new DataView(logical.buffer, 0, 48);
  hv.setUint32(8, 1, true);   // major
  hv.setUint32(12, 0, true);  // minor
  hv.setBigUint64(16, BigInt(logicalLen), true);                              // fileLogicalSize (logical)
  hv.setBigUint64(24, BigInt(logicalToPhysical(xmlLogicalOffset, pageSize)), true); // xmlPhysicalOffset
  hv.setBigUint64(32, BigInt(xmlBytes.length), true);                         // xmlLogicalLength
  hv.setBigUint64(40, BigInt(pageSize), true);                                // pageSize

  // CompressedVector section header (32 bytes).
  const sv = new DataView(logical.buffer, sectionLogicalOffset, 32);
  sv.setUint8(0, 1); // sectionId = CompressedVector
  sv.setBigUint64(8, BigInt(32 + packets.length), true);                      // sectionLogicalLength
  sv.setBigUint64(16, BigInt(logicalToPhysical(dataLogicalOffset, pageSize)), true); // dataPhysicalOffset
  sv.setBigUint64(24, 0n, true);                                              // indexPhysicalOffset

  // Data + XML.
  logical.set(packets, dataLogicalOffset);
  logical.set(xmlBytes, xmlLogicalOffset);

  const physical = inflateToPhysical(logical, pageSize);
  return { blob: new Blob([physical]), physical };
}

/**
 * Build a complete, CRC-paged MULTI-scan E57 file as a Blob. Each scan
 * gets its own CompressedVector section header + data region, laid out
 * back-to-back: [header 48 / pad 64] [sec0 32][data0] [sec1 32][data1] … [xml].
 * All scans here are cartesian-only (no colour) to keep the layout simple.
 */
function buildMultiScanE57(
  scans: TestPoint[][],
  opts: { pageSize?: number; pointsPerPacket?: number } = {},
): { blob: Blob; physical: Uint8Array } {
  const pageSize = opts.pageSize ?? 256;
  const ppp = opts.pointsPerPacket ?? 8;

  let cursor = 64;
  const layout = scans.map((pts) => {
    const packets = buildDataPackets(pts, ppp);
    const sectionLogicalOffset = cursor;
    const dataLogicalOffset = cursor + 32;
    cursor = dataLogicalOffset + packets.length;
    return { pts, packets, sectionLogicalOffset, dataLogicalOffset };
  });
  const xmlLogicalOffset = cursor;

  const children = layout.map((s, i) =>
    `<vectorChild type="Structure">`
    + `<guid type="String">{scan-${i + 1}}</guid>`
    + `<points type="CompressedVector" fileOffset="${logicalToPhysical(s.sectionLogicalOffset, pageSize)}" recordCount="${s.pts.length}">`
    + `<prototype type="Structure">`
    + `<cartesianX type="Float" precision="single"/>`
    + `<cartesianY type="Float" precision="single"/>`
    + `<cartesianZ type="Float" precision="single"/>`
    + `</prototype>`
    + `</points>`
    + `</vectorChild>`,
  ).join('');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>`
    + `<e57Root type="Structure"><data3D type="Vector">${children}</data3D></e57Root>`;
  const xmlBytes = enc.encode(xml);

  const logicalLen = xmlLogicalOffset + xmlBytes.length;
  const logical = new Uint8Array(logicalLen);

  logical.set(enc.encode('ASTM-E57'), 0);
  const hv = new DataView(logical.buffer, 0, 48);
  hv.setUint32(8, 1, true);
  hv.setUint32(12, 0, true);
  hv.setBigUint64(16, BigInt(logicalLen), true);
  hv.setBigUint64(24, BigInt(logicalToPhysical(xmlLogicalOffset, pageSize)), true);
  hv.setBigUint64(32, BigInt(xmlBytes.length), true);
  hv.setBigUint64(40, BigInt(pageSize), true);

  for (const s of layout) {
    const sv = new DataView(logical.buffer, s.sectionLogicalOffset, 32);
    sv.setUint8(0, 1);
    sv.setBigUint64(8, BigInt(32 + s.packets.length), true);
    sv.setBigUint64(16, BigInt(logicalToPhysical(s.dataLogicalOffset, pageSize)), true);
    sv.setBigUint64(24, 0n, true);
    logical.set(s.packets, s.dataLogicalOffset);
  }
  logical.set(xmlBytes, xmlLogicalOffset);

  const physical = inflateToPhysical(logical, pageSize);
  return { blob: new Blob([physical]), physical };
}

async function drain(src: E57StreamingSource, maxPoints: number): Promise<DecodedPointChunk[]> {
  await src.open();
  const chunks: DecodedPointChunk[] = [];
  let c: DecodedPointChunk | null;
  // eslint-disable-next-line no-cond-assign
  while ((c = await src.next(maxPoints)) !== null) chunks.push(c);
  return chunks;
}

function mergePositions(chunks: DecodedPointChunk[]): number[] {
  const out: number[] = [];
  for (const c of chunks) for (let i = 0; i < c.pointCount * 3; i++) out.push(c.positions[i]);
  return out;
}

function totalPoints(chunks: DecodedPointChunk[]): number {
  return chunks.reduce((a, c) => a + c.pointCount, 0);
}

describe('logicalToPhysical', () => {
  it('is the inverse of physicalToLogical across page boundaries', () => {
    const pageSize = 256;
    const payload = pageSize - 4;
    for (const logical of [0, 1, 251, 252, 253, 503, 504, 1000, 5000]) {
      expect(physicalToLogical(logicalToPhysical(logical, pageSize), pageSize)).toBe(logical);
    }
    // Logical 252 lands at the start of physical page 1's payload.
    expect(logicalToPhysical(payload, pageSize)).toBe(pageSize);
  });
});

describe('E57StreamingSource', () => {
  const points: TestPoint[] = [];
  for (let i = 0; i < 50; i++) {
    points.push({ x: i * 0.5, y: i * 0.25 - 5, z: -i, r: i % 256, g: (i * 2) % 256, b: (i * 3) % 256 });
  }

  it('streams positions + colours identical to the whole-file decoder', async () => {
    const { blob, physical } = buildE57(points, { pageSize: 256, pointsPerPacket: 8 });
    const reference = decodeE57(physical);
    expect(reference).not.toBeNull();
    expect(reference!.pointCount).toBe(50);

    const src = new E57StreamingSource(blob);
    const chunks = await drain(src, 200_000);
    expect(totalPoints(chunks)).toBe(50);
    expect(mergePositions(chunks)).toEqual(Array.from(reference!.positions));

    // Colours present and matching the reference decode.
    const mergedColors: number[] = [];
    for (const c of chunks) {
      expect(c.colors).toBeDefined();
      for (let i = 0; i < c.pointCount * 3; i++) mergedColors.push(c.colors![i]);
    }
    expect(mergedColors.length).toBe(150);
    for (let i = 0; i < 150; i++) expect(mergedColors[i]).toBeCloseTo(reference!.colors![i], 5);
  });

  it('emits multiple chunks when maxPoints is below the point count', async () => {
    const { blob } = buildE57(points, { pageSize: 256, pointsPerPacket: 8 });
    const src = new E57StreamingSource(blob);
    const chunks = await drain(src, 10);
    expect(chunks.length).toBeGreaterThan(1);
    expect(totalPoints(chunks)).toBe(50);
    for (const c of chunks) expect(c.pointCount).toBeLessThanOrEqual(10 + 8); // ≤ maxPoints + one packet overshoot
  });

  it('reassembles a packet bigger than the read window (grow path)', async () => {
    const { blob, physical } = buildE57(points, { pageSize: 256, pointsPerPacket: 8 });
    const reference = decodeE57(physical);
    // windowBytes below a single packet forces the "grow window to the
    // packet length" path on every read.
    const src = new E57StreamingSource(blob, { windowBytes: 70 });
    const chunks = await drain(src, 200_000);
    expect(totalPoints(chunks)).toBe(50);
    expect(mergePositions(chunks)).toEqual(Array.from(reference!.positions));
  });

  it('handles a packet straddling a multi-packet window (re-read path)', async () => {
    const { blob, physical } = buildE57(points, { pageSize: 256, pointsPerPacket: 8 });
    const reference = decodeE57(physical);
    // ~2 packets per window: each window decodes the packets it fully
    // holds, then breaks on the straddling tail and re-reads from the
    // advanced cursor — without growing the window.
    const src = new E57StreamingSource(blob, { windowBytes: 250 });
    const chunks = await drain(src, 200_000);
    expect(totalPoints(chunks)).toBe(50);
    expect(mergePositions(chunks)).toEqual(Array.from(reference!.positions));
  });

  it('applies stride downsampling natively', async () => {
    const { blob } = buildE57(points, { pageSize: 256, pointsPerPacket: 8 });
    const src = new E57StreamingSource(blob, { downsample: { stride: 5 } });
    const info = await src.open();
    expect(info.totalPointCount).toBe(Math.ceil(50 / 5)); // 10
    const chunks: DecodedPointChunk[] = [];
    let c: DecodedPointChunk | null;
    // eslint-disable-next-line no-cond-assign
    while ((c = await src.next(200_000)) !== null) chunks.push(c);
    // 50 points strided by 5 → first kept index 0,5,10,…,45 = 10 points.
    expect(totalPoints(chunks)).toBe(10);
    const xs = mergePositions(chunks).filter((_, i) => i % 3 === 0);
    expect(xs).toEqual([0, 2.5, 5, 7.5, 10, 12.5, 15, 17.5, 20, 22.5]);
  });

  it('strides multi-scan files on the merged global index, not per-scan', async () => {
    // Two scans with disjoint x ranges so a per-scan phase reset (the
    // pre-fix bug) is visible in the output: scan A x∈[0,28), scan B
    // x∈[100,132). Merged global order is A (idx 0..27) then B (idx 28..59).
    const scanA: TestPoint[] = [];
    for (let i = 0; i < 28; i++) scanA.push({ x: i, y: 0, z: 0 });
    const scanB: TestPoint[] = [];
    for (let i = 0; i < 32; i++) scanB.push({ x: 100 + i, y: 0, z: 0 });

    const { blob, physical } = buildMultiScanE57([scanA, scanB], { pageSize: 256, pointsPerPacket: 8 });

    // Reference: whole-file decode (merged, scan order) then GLOBAL stride.
    const reference = decodeE57(physical);
    expect(reference).not.toBeNull();
    expect(reference!.pointCount).toBe(60);
    const stride = 5;
    const refXs = Array.from(reference!.positions).filter((_, i) => i % 3 === 0);
    const expectedXs = refXs.filter((_, p) => p % stride === 0);

    const src = new E57StreamingSource(blob, { downsample: { stride } });
    const info = await src.open();
    // Reported count must equal what is actually emitted (ceil(60/5)=12).
    expect(info.totalPointCount).toBe(Math.ceil(60 / stride));

    const chunks = await drain(src, 200_000);
    expect(totalPoints(chunks)).toBe(Math.ceil(60 / stride));
    const gotXs = mergePositions(chunks).filter((_, i) => i % 3 === 0);
    // Global indices 0,5,…,55 → scan A x=0,5,10,15,20,25; then the phase
    // CARRIES across the boundary: next kept global index is 30 (not 28),
    // i.e. scan B local 2,7,12,17,22,27 → x=102,107,112,117,122,127.
    // A per-scan reset (the bug) would instead emit 13 pts ending
    // 100,105,…,130. This asserts the file-global phase.
    expect(gotXs).toEqual([0, 5, 10, 15, 20, 25, 102, 107, 112, 117, 122, 127]);
    expect(gotXs).toEqual(expectedXs);
  });

  it('streams multi-scan files identically to the whole-file decoder (stride 1)', async () => {
    const scanA: TestPoint[] = [];
    for (let i = 0; i < 13; i++) scanA.push({ x: i, y: i + 1, z: i + 2 });
    const scanB: TestPoint[] = [];
    for (let i = 0; i < 19; i++) scanB.push({ x: 50 + i, y: 60 + i, z: 70 + i });
    const { blob, physical } = buildMultiScanE57([scanA, scanB], { pageSize: 256, pointsPerPacket: 8 });
    const reference = decodeE57(physical);
    expect(reference!.pointCount).toBe(32);
    const src = new E57StreamingSource(blob);
    const chunks = await drain(src, 200_000);
    expect(totalPoints(chunks)).toBe(32);
    expect(mergePositions(chunks)).toEqual(Array.from(reference!.positions));
  });

  it('reports header metadata via open()', async () => {
    const { blob } = buildE57(points, { pageSize: 256 });
    const src = new E57StreamingSource(blob, { label: 'apt.e57' });
    const info = await src.open();
    expect(info.totalPointCount).toBe(50);
    expect(info.hasColor).toBe(true);
    expect(info.hasIntensity).toBe(false);
    expect(info.label).toBe('apt.e57');
  });

  it('throws a clear error on a file with no Data3D scans', async () => {
    const { blob } = buildE57([], { pageSize: 256, emptyData3D: true });
    const src = new E57StreamingSource(blob);
    await expect(src.open()).rejects.toThrow(/no Data3D scans/);
  });
});
