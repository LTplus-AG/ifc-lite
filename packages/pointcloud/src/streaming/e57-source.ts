/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * E57 (ASTM E2807-11) streaming source.
 *
 * Unlike a naive "read the whole file, then decode" approach — which
 * allocates the entire file (plus a CRC-stripped copy of it) in one
 * `ArrayBuffer` and dies with "Array buffer allocation failed" on
 * multi-GB scans — this source reads the binary CompressedVector
 * section incrementally:
 *
 *   open():  read the 48-byte FileHeader + the (small) XML section, then
 *            resolve every Data3D scan's binary data offset by reading
 *            just its 32-byte CompressedVector section header.
 *   next():  read a bounded LOGICAL window from the blob (page-CRC
 *            stripped on the fly), walk the DataPackets inside it,
 *            apply stride + per-scan pose, and emit a decoded chunk.
 *
 * Peak memory is therefore ~one window (≤ 16 MiB) plus one output chunk,
 * not the whole file. The per-packet decode primitives are shared with
 * the whole-file `decodeE57Scan` so both paths agree byte-for-byte.
 */

import type { DecodedPointChunk } from '../types.js';
import {
  computeBBox,
  decodeE57Packet,
  peekPacketHeader,
  resolveScanFields,
  type DecodedPacket,
  type ScanFieldSet,
} from '../formats/e57-decode.js';
import { applyPoseInPlace } from '../formats/e57.js';
import {
  parseE57FileHeader,
  physicalToLogical,
  readU64LE,
  stripPageCrc,
} from '../formats/e57-page.js';
import {
  parseE57Xml,
  type Data3DEntry,
  type E57Pose,
  type PrototypeField,
} from '../formats/e57-xml.js';
import { BlobByteSource } from './blob-source.js';
import type {
  DownsampleHint,
  PointSourceInfo,
  StreamingPointSource,
} from './types.js';

/** 1 MiB — always ≥ any single packet (E57 packets are ≤ 64 KiB). */
const MIN_WINDOW_BYTES = 1 << 20;
/** 16 MiB — caps peak window memory per `next()`. */
const MAX_WINDOW_BYTES = 16 << 20;

/** Pre-resolved plan for one Data3D scan, built once in `open()`. */
interface ScanPlan {
  recordCount: number;
  /** Logical offset of the first DataPacket (post CompressedVector header). */
  dataLogicalOffset: number;
  fields: ScanFieldSet;
  prototype: PrototypeField[];
  pose?: E57Pose;
  /** Estimated logical bytes per record — used only for window sizing. */
  bytesPerRecord: number;
}

/** A stride-selected, pose-applied slice of one decoded packet. */
interface SelectedPart {
  count: number;
  positions: Float32Array;
  colors?: Float32Array;
  intensities?: Uint16Array;
  classifications?: Uint8Array;
}

export class E57StreamingSource implements StreamingPointSource {
  private bytes: BlobByteSource;
  private downsample: DownsampleHint;
  private label?: string;
  /** Test hook: force a fixed window size to exercise straddle/re-read. */
  private windowBytesOverride?: number;

  private opened = false;
  private pageSize = 1024;
  private fileLogicalSize = 0;
  private scans: ScanPlan[] = [];
  private totalPointCount = 0;
  private hasColor = false;
  private hasIntensity = false;
  private hasClassification = false;

  // Streaming cursor.
  private scanIdx = 0;
  private logCursor = 0;
  /** Records consumed of the CURRENT scan (resets at each scan boundary). */
  private recordsWritten = 0;
  /**
   * Cumulative declared `recordCount` of every scan BEFORE the current one.
   * `scanRecordBase + recordsWritten` is the record's index in the merged
   * multi-scan cloud — the phase the stride must align to so downsampling
   * matches the whole-file decoder (which strides the merged cloud globally)
   * rather than restarting the stride phase inside each scan.
   */
  private scanRecordBase = 0;

  constructor(
    blob: Blob,
    options: { label?: string; downsample?: DownsampleHint; windowBytes?: number } = {},
  ) {
    this.bytes = new BlobByteSource(blob);
    this.downsample = options.downsample ?? { stride: 1 };
    this.label = options.label;
    this.windowBytesOverride = options.windowBytes;
  }

  async open(signal?: AbortSignal): Promise<PointSourceInfo> {
    if (this.opened) return this.toInfo();
    abortIfAborted(signal);

    const headerBytes = await this.bytes.read(0, 64);
    abortIfAborted(signal);
    const header = parseE57FileHeader(headerBytes);
    if (header.pageSize <= 4) {
      throw new Error(`E57: invalid pageSize ${header.pageSize}`);
    }
    this.pageSize = header.pageSize;
    // Prefer the header's logical size; fall back to the blob size mapped
    // through the page math when a producer leaves fileLogicalSize at 0.
    this.fileLogicalSize = header.fileLogicalSize > 0
      ? header.fileLogicalSize
      : physicalToLogical(this.bytes.size, header.pageSize);

    const xmlLogical = await readLogicalRange(
      this.bytes, header.xmlLogicalOffset, header.xmlLogicalLength, header.pageSize,
    );
    abortIfAborted(signal);
    const xmlText = new TextDecoder().decode(xmlLogical);
    const entries = parseE57Xml(xmlText);
    if (entries.length === 0) {
      throw new Error('E57: file contains no Data3D scans');
    }

    const scans: ScanPlan[] = [];
    let total = 0;
    for (const entry of entries) {
      const dataLogicalOffset = await this.resolveDataOffset(entry, header.pageSize, signal);
      const fields = resolveScanFields(entry.prototype);
      scans.push({
        recordCount: entry.recordCount,
        dataLogicalOffset,
        fields,
        prototype: entry.prototype,
        pose: entry.pose,
        bytesPerRecord: estimateBytesPerRecord(entry.prototype),
      });
      total += entry.recordCount;
    }

    this.scans = scans;
    this.totalPointCount = total;
    this.hasColor = scans.some((s) => s.fields.hasRgb);
    this.hasIntensity = scans.some((s) => s.fields.hasIntensity);
    this.hasClassification = scans.some((s) => s.fields.hasClassification);
    this.scanIdx = 0;
    this.logCursor = scans[0].dataLogicalOffset;
    this.recordsWritten = 0;
    this.scanRecordBase = 0;
    this.opened = true;
    return this.toInfo();
  }

  async next(maxPoints: number, signal?: AbortSignal): Promise<DecodedPointChunk | null> {
    abortIfAborted(signal);
    if (!this.opened) {
      throw new Error('E57StreamingSource: open() must be awaited before next()');
    }
    if (!Number.isFinite(maxPoints) || maxPoints <= 0) {
      // 0/negative would emit empty chunks without advancing the cursor,
      // creating a non-terminating loop in the host.
      throw new Error(`E57StreamingSource: maxPoints must be > 0 (got ${maxPoints})`);
    }
    const stride = Math.max(1, this.downsample.stride | 0);

    const parts: SelectedPart[] = [];
    let produced = 0;
    let anyColor = false;
    let anyIntensity = false;
    let anyClassification = false;

    while (produced < maxPoints) {
      abortIfAborted(signal);

      // Skip past any fully-consumed scans, re-seating the cursor on the
      // next scan's data region.
      while (
        this.scanIdx < this.scans.length
        && this.recordsWritten >= this.scans[this.scanIdx].recordCount
      ) {
        // Carry the finished scan's full declared record count into the
        // file-global phase so the next scan keeps striding on the merged
        // cloud's index line (…, k·stride, …) instead of re-aligning to 0.
        this.scanRecordBase += this.scans[this.scanIdx].recordCount;
        this.scanIdx++;
        if (this.scanIdx < this.scans.length) {
          this.logCursor = this.scans[this.scanIdx].dataLogicalOffset;
          this.recordsWritten = 0;
        }
      }
      if (this.scanIdx >= this.scans.length) break; // stream exhausted
      const scan = this.scans[this.scanIdx];

      const windowLen = this.computeWindowLen(scan, maxPoints - produced, stride);
      if (windowLen <= 0) {
        // No file bytes remain for this scan (over-reported recordCount).
        this.recordsWritten = scan.recordCount;
        continue;
      }
      let window = await readLogicalRange(this.bytes, this.logCursor, windowLen, this.pageSize);
      abortIfAborted(signal);
      if (window.length === 0) {
        this.recordsWritten = scan.recordCount;
        continue;
      }
      let view = new DataView(window.buffer, window.byteOffset, window.byteLength);

      // Guarantee the first packet fits: if it straddles the window end
      // and we're not at EOF, re-read a window sized to exactly that
      // packet. (With the default ≥1 MiB window this never fires; it
      // matters only for the tiny windows tests use.)
      if (window.length >= 4) {
        const peek0 = peekPacketHeader(view, 0);
        const atEof = this.logCursor + window.length >= this.fileLogicalSize;
        if (peek0.packetLength > window.length && !atEof) {
          window = await readLogicalRange(this.bytes, this.logCursor, peek0.packetLength, this.pageSize);
          abortIfAborted(signal);
          view = new DataView(window.buffer, window.byteOffset, window.byteLength);
        }
      }

      let local = 0;
      let progressed = false;
      while (produced < maxPoints && this.recordsWritten < scan.recordCount) {
        if (local + 4 > window.length) break; // header needs more bytes
        const peek = peekPacketHeader(view, local);
        if (local + peek.packetLength > window.length) {
          // Packet straddles the window end. We've already advanced
          // logCursor past every packet consumed so far; break and let
          // the outer loop re-read a fresh window starting at this packet.
          break;
        }
        const packet = decodeE57Packet(
          window, view, local, scan.fields, scan.prototype, scan.recordCount - this.recordsWritten,
        );
        if (packet.packetType !== 1) {
          // Skip non-data packets (index/empty); may appear interleaved.
          local += packet.packetLength;
          this.logCursor += packet.packetLength;
          progressed = true;
          continue;
        }
        if (packet.take > 0 && packet.positions) {
          // Phase the stride on the file-global record index so multi-scan
          // downsampling matches the whole-file decoder, not per-scan.
          const sel = selectStride(packet, this.scanRecordBase + this.recordsWritten, stride, scan.pose);
          if (sel.count > 0) {
            parts.push(sel);
            produced += sel.count;
            if (sel.colors) anyColor = true;
            if (sel.intensities) anyIntensity = true;
            if (sel.classifications) anyClassification = true;
          }
          this.recordsWritten += packet.take;
        }
        local += packet.packetLength;
        this.logCursor += packet.packetLength;
        progressed = true;
      }

      if (!progressed) {
        // Nothing consumable in this window despite bytes remaining —
        // only reachable when the file ends mid-packet (truncated or
        // over-reported recordCount). Drop the scan's phantom tail, like
        // the whole-file decoder trims its under-filled output.
        this.recordsWritten = scan.recordCount;
      }
    }

    if (produced === 0) return null;
    return concatParts(parts, produced, anyColor, anyIntensity, anyClassification);
  }

  close(): void {
    this.opened = false;
    this.scans = [];
    this.scanIdx = 0;
    this.logCursor = 0;
    this.recordsWritten = 0;
    this.scanRecordBase = 0;
  }

  /**
   * Resolve a scan's binary data offset by reading its 32-byte
   * CompressedVector section header (E57 §6.4.2). The XML's `fileOffset`
   * points at this section header, not the first DataPacket.
   */
  private async resolveDataOffset(
    entry: Data3DEntry,
    pageSize: number,
    signal?: AbortSignal,
  ): Promise<number> {
    const sectionLogical = physicalToLogical(entry.binaryFileOffset, pageSize);
    const headerBytes = await readLogicalRange(this.bytes, sectionLogical, 32, pageSize);
    abortIfAborted(signal);
    if (headerBytes.length < 32) {
      throw new Error(
        `E57: CompressedVector section header at logical ${sectionLogical} runs past end of file`,
      );
    }
    const view = new DataView(headerBytes.buffer, headerBytes.byteOffset, headerBytes.byteLength);
    const sectionId = view.getUint8(0);
    if (sectionId !== 1) {
      throw new Error(
        `E57: expected CompressedVector section (id=1) at physical ${entry.binaryFileOffset}, got id=${sectionId}`,
      );
    }
    const dataPhysicalOffset = readU64LE(view, 16);
    return physicalToLogical(dataPhysicalOffset, pageSize);
  }

  /** Logical bytes to pull on the next read — bounded and EOF-clamped. */
  private computeWindowLen(scan: ScanPlan, remainingPoints: number, stride: number): number {
    const remainingFile = this.fileLogicalSize - this.logCursor;
    if (remainingFile <= 0) return 0;
    if (this.windowBytesOverride && this.windowBytesOverride > 0) {
      return Math.min(this.windowBytesOverride, remainingFile);
    }
    // Aim for ~remainingPoints worth of source records, +15% slack for
    // packet/bytestream-table overhead, clamped to [MIN, MAX].
    const want = remainingPoints * stride * scan.bytesPerRecord * 1.15 + 4096;
    const len = Math.min(MAX_WINDOW_BYTES, Math.max(MIN_WINDOW_BYTES, want));
    return Math.min(len, remainingFile);
  }

  private toInfo(): PointSourceInfo {
    const stride = Math.max(1, this.downsample.stride | 0);
    return {
      totalPointCount: stride === 1
        ? this.totalPointCount
        : Math.ceil(this.totalPointCount / stride),
      // The source-wide bbox is aggregated by the host from each emitted
      // chunk's bbox; we can't know it without decoding, so report a
      // finite zero bbox as the fallback the host only uses if no chunk
      // is ever emitted.
      bbox: { min: [0, 0, 0], max: [0, 0, 0] },
      hasColor: this.hasColor,
      hasClassification: this.hasClassification,
      hasIntensity: this.hasIntensity,
      label: this.label,
    };
  }
}

/**
 * Read a LOGICAL byte range [logStart, logStart+logLength) from a
 * CRC-paged E57 file. Reads the covering physical page span, strips the
 * 4-byte per-page CRC tails, and returns the requested logical slice.
 *
 * Returns fewer bytes than requested (or empty) near EOF — callers treat
 * a short read as "scan ends here".
 */
async function readLogicalRange(
  src: BlobByteSource,
  logStart: number,
  logLength: number,
  pageSize: number,
): Promise<Uint8Array> {
  if (logLength <= 0) return new Uint8Array(0);
  const payloadPerPage = pageSize - 4;
  const firstPage = Math.floor(logStart / payloadPerPage);
  const logicalPageStart = firstPage * payloadPerPage;
  const physicalStart = firstPage * pageSize;
  const logEnd = logStart + logLength;
  // Page containing the last byte we need (inclusive).
  const lastPage = Math.floor((logEnd - 1) / payloadPerPage);
  const physicalEnd = (lastPage + 1) * pageSize; // exclusive; read() clamps to size
  const physical = await src.read(physicalStart, physicalEnd);
  if (physical.length === 0) return new Uint8Array(0);
  // `physical` starts on a page boundary, so stripPageCrc treats byte 0
  // as a page start correctly. A clamped (EOF) tail is handled by
  // stripPageCrc's partial-page logic.
  const logical = stripPageCrc(physical, pageSize);
  const rel = logStart - logicalPageStart;
  if (rel >= logical.length) return new Uint8Array(0);
  return logical.subarray(rel, Math.min(rel + logLength, logical.length));
}

/**
 * Take every `stride`-th record from a decoded packet (phased by the
 * file-global record index `base` — the record's position in the merged
 * multi-scan cloud, so the kept set is {i : (base+j) ≡ 0 mod stride})
 * and apply the scan's pose. Returns a fresh, tightly-sized slice — the
 * packet's own buffers are reused verbatim when `stride === 1`.
 */
function selectStride(
  packet: DecodedPacket,
  base: number,
  stride: number,
  pose?: E57Pose,
): SelectedPart {
  const take = packet.take;
  const pos = packet.positions!;
  if (stride === 1) {
    if (pose) applyPoseInPlace(pos, take, pose);
    return {
      count: take,
      positions: pos,
      colors: packet.colors,
      intensities: packet.intensities,
      classifications: packet.classifications,
    };
  }
  // First in-packet index j whose global index (base+j) is stride-aligned.
  const firstKept = (stride - (base % stride)) % stride;
  let count = 0;
  for (let j = firstKept; j < take; j += stride) count++;

  const positions = new Float32Array(count * 3);
  const colors = packet.colors ? new Float32Array(count * 3) : undefined;
  const intensities = packet.intensities ? new Uint16Array(count) : undefined;
  const classifications = packet.classifications ? new Uint8Array(count) : undefined;
  let dst = 0;
  for (let j = firstKept; j < take; j += stride) {
    positions[dst * 3] = pos[j * 3];
    positions[dst * 3 + 1] = pos[j * 3 + 1];
    positions[dst * 3 + 2] = pos[j * 3 + 2];
    if (colors && packet.colors) {
      colors[dst * 3] = packet.colors[j * 3];
      colors[dst * 3 + 1] = packet.colors[j * 3 + 1];
      colors[dst * 3 + 2] = packet.colors[j * 3 + 2];
    }
    if (intensities && packet.intensities) intensities[dst] = packet.intensities[j];
    if (classifications && packet.classifications) classifications[dst] = packet.classifications[j];
    dst++;
  }
  if (pose) applyPoseInPlace(positions, count, pose);
  return { count, positions, colors, intensities, classifications };
}

/**
 * Concatenate per-packet selected parts into one chunk. Channels are
 * unioned across parts (a multi-scan chunk where one scan lacks colour
 * leaves that scan's slice at zeros), mirroring `decodeE57`'s merge.
 */
function concatParts(
  parts: SelectedPart[],
  total: number,
  anyColor: boolean,
  anyIntensity: boolean,
  anyClassification: boolean,
): DecodedPointChunk {
  const positions = new Float32Array(total * 3);
  const colors = anyColor ? new Float32Array(total * 3) : undefined;
  const intensities = anyIntensity ? new Uint16Array(total) : undefined;
  const classifications = anyClassification ? new Uint8Array(total) : undefined;
  let off = 0;
  for (const p of parts) {
    positions.set(p.positions, off * 3);
    if (colors && p.colors) colors.set(p.colors, off * 3);
    if (intensities && p.intensities) intensities.set(p.intensities, off);
    if (classifications && p.classifications) classifications.set(p.classifications, off);
    off += p.count;
  }
  return {
    positions,
    colors,
    intensities,
    classifications,
    pointCount: total,
    bbox: computeBBox(positions),
  };
}

/** Rough logical bytes per record — window-sizing heuristic only. */
function estimateBytesPerRecord(prototype: PrototypeField[]): number {
  let bytes = 0;
  for (const f of prototype) {
    if (f.kind === 'Float') {
      bytes += f.precision === 'single' ? 4 : 8;
    } else if (f.kind === 'Integer') {
      const widest = Math.max(Math.abs(f.minimum ?? 0), Math.abs(f.maximum ?? 255));
      bytes += widest > 255 ? 2 : 1;
    } else {
      // ScaledInteger: ceil(log2(span+1)) bits per record.
      const span = Math.max(0, (f.maximum ?? 0) - (f.minimum ?? 0));
      const bits = span <= 0 ? 1 : Math.ceil(Math.log2(span + 1));
      bytes += bits / 8;
    }
  }
  return Math.max(1, bytes);
}

function abortIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
}
