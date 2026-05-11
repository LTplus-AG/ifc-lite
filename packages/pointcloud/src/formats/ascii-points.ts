/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * PTS / XYZ ASCII point reader.
 *
 * Both formats are line-oriented plain-text scans. They differ only
 * in the optional first-line point count (PTS may have one; XYZ
 * never does) and in convention rather than syntax.
 *
 * Supported per-line layouts (auto-detected from column count of the
 * first data line):
 *   3 cols  →  X Y Z
 *   4 cols  →  X Y Z I       (intensity, normalised 0..1 or 0..255)
 *   6 cols  →  X Y Z R G B   (RGB 0..255)
 *   7 cols  →  X Y Z I R G B (PTS standard layout)
 *   9 cols  →  X Y Z I R G B Nx Ny Nz  (normals dropped)
 *
 * Lines starting with `#`, `//`, or blank are skipped (comment
 * support is non-standard but common in field exports).
 *
 * The reader is intentionally tolerant: any column count outside the
 * known set falls through to "X Y Z plus discarded extras" so a file
 * with weird custom columns still loads.
 */

import type { DecodedPointChunk, PointCloudBBox } from '../types.js';

export type AsciiPointsFormat = 'pts' | 'xyz';

export interface AsciiPointsLayout {
  /** Number of whitespace-separated columns per data line. */
  columns: number;
  /** True if the first non-comment line is a single-integer point count. */
  hasHeaderCount: boolean;
  /** Resolved per-column meaning for the auto-detected layout. */
  fields: AsciiPointsField[];
}

export type AsciiPointsField = 'x' | 'y' | 'z' | 'i' | 'r' | 'g' | 'b' | 'skip';

const TEXT_DECODER = new TextDecoder();

/**
 * Probe the first ~16 KB to decide format + column layout.
 *
 * Looks at the first non-blank/non-comment line:
 *   - If it's a single integer, treat as a header point count (PTS).
 *   - Otherwise the column count of that line determines the layout.
 *
 * Returns null when the buffer doesn't look like ASCII point data
 * (e.g. binary content, non-numeric tokens). Caller can then surface
 * a clear "not a point cloud" error.
 */
export function probeAsciiPointsLayout(
  buffer: Uint8Array,
  format: AsciiPointsFormat,
): AsciiPointsLayout | null {
  const probeLen = Math.min(16384, buffer.length);
  const text = TEXT_DECODER.decode(buffer.subarray(0, probeLen));
  const lines = text.split(/\r?\n/);
  let firstDataLine: string | null = null;
  let hasHeaderCount = false;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
    // PTS often begins with a single integer point count. XYZ never
    // does — but we still accept it as a header if it parses cleanly.
    if (i === 0 || !hasHeaderCount) {
      const tokens = trimmed.split(/\s+/);
      if (tokens.length === 1 && /^\d+$/.test(tokens[0])) {
        hasHeaderCount = true;
        continue;
      }
    }
    firstDataLine = trimmed;
    break;
  }
  if (firstDataLine === null) return null;
  const tokens = firstDataLine.split(/\s+/);
  const columns = tokens.length;
  // Sanity: every token must parse as a finite number.
  for (const t of tokens) {
    if (!Number.isFinite(Number(t))) return null;
  }
  const fields = layoutFromColumnCount(columns, format);
  if (!fields) return null;
  return { columns, hasHeaderCount, fields };
}

/**
 * Resolve a column count to its field roles. Returns null when the
 * count isn't one of the known shapes — caller should surface a clear
 * "unsupported column layout" error rather than guess.
 */
function layoutFromColumnCount(
  columns: number,
  format: AsciiPointsFormat,
): AsciiPointsField[] | null {
  switch (columns) {
    case 3:
      return ['x', 'y', 'z'];
    case 4:
      // Convention: 4-col PTS is X Y Z I; 4-col XYZ is rarer and
      // sometimes X Y Z R (single-channel grayscale). We treat both
      // as intensity to keep the logic shared — single-channel
      // colour shows up greyscale anyway.
      return ['x', 'y', 'z', 'i'];
    case 6:
      return ['x', 'y', 'z', 'r', 'g', 'b'];
    case 7:
      // Canonical PTS (X Y Z I R G B) and the most common XYZ-with-
      // colour-and-intensity layout.
      return ['x', 'y', 'z', 'i', 'r', 'g', 'b'];
    case 9:
      // X Y Z R G B Nx Ny Nz — colour but no intensity, drop normals.
      return ['x', 'y', 'z', 'r', 'g', 'b', 'skip', 'skip', 'skip'];
    case 10:
      // X Y Z I R G B Nx Ny Nz — full PTS-with-normals. Drop normals.
      return ['x', 'y', 'z', 'i', 'r', 'g', 'b', 'skip', 'skip', 'skip'];
    default:
      // Tolerant fallback for unknown layouts — still emit positions
      // from the first three columns so the cloud loads. Discard the
      // rest. Better than rejecting the whole file.
      if (columns >= 3 && format === 'xyz') {
        const fields: AsciiPointsField[] = ['x', 'y', 'z'];
        for (let i = 3; i < columns; i++) fields.push('skip');
        return fields;
      }
      return null;
  }
}

/**
 * Decode an entire ASCII point file into a single `DecodedPointChunk`.
 *
 * For multi-gigabyte scans the streaming source (`AsciiPointsStreamingSource`)
 * should be preferred — this path materialises everything in memory.
 *
 * Per-channel handling:
 *   - Intensity: if any value > 1.0, treat the column as 0..255 and
 *     scale to u16. Otherwise treat as 0..1 and scale to u16. Mixed
 *     ranges within one file are uncommon; we make the call once.
 *   - RGB: if any channel > 1.0, treat the columns as 0..255. Else 0..1.
 */
export function decodeAsciiPoints(
  bytes: Uint8Array,
  format: AsciiPointsFormat,
): DecodedPointChunk {
  const layout = probeAsciiPointsLayout(bytes, format);
  if (!layout) {
    throw new Error(`${format.toUpperCase()}: file does not look like ASCII point data`);
  }
  const text = TEXT_DECODER.decode(bytes);
  return decodeAsciiPointsFromText(text, layout);
}

/** Same as `decodeAsciiPoints` but takes pre-decoded text. */
export function decodeAsciiPointsFromText(
  text: string,
  layout: AsciiPointsLayout,
): DecodedPointChunk {
  const lines = text.split(/\r?\n/);
  // Pre-pass: count valid data lines so we can allocate exactly.
  // Cheap (no parsing) and saves the typed-array growth dance.
  let dataLineCount = 0;
  let headerSkipped = !layout.hasHeaderCount;
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
    if (!headerSkipped) {
      headerSkipped = true;
      continue;
    }
    dataLineCount++;
  }

  const xIdx = layout.fields.indexOf('x');
  const yIdx = layout.fields.indexOf('y');
  const zIdx = layout.fields.indexOf('z');
  const iIdx = layout.fields.indexOf('i');
  const rIdx = layout.fields.indexOf('r');
  const gIdx = layout.fields.indexOf('g');
  const bIdx = layout.fields.indexOf('b');
  const hasIntensity = iIdx >= 0;
  const hasColor = rIdx >= 0 && gIdx >= 0 && bIdx >= 0;

  const positions = new Float32Array(dataLineCount * 3);
  const intensitiesRaw = hasIntensity ? new Float32Array(dataLineCount) : null;
  const colorsRaw = hasColor ? new Float32Array(dataLineCount * 3) : null;

  let written = 0;
  let intensityMax = 0;
  let colorMax = 0;
  let bboxMinX = Infinity, bboxMinY = Infinity, bboxMinZ = Infinity;
  let bboxMaxX = -Infinity, bboxMaxY = -Infinity, bboxMaxZ = -Infinity;

  headerSkipped = !layout.hasHeaderCount;
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
    if (!headerSkipped) {
      headerSkipped = true;
      continue;
    }
    const tokens = trimmed.split(/\s+/);
    if (tokens.length < layout.columns) continue;
    const x = Number(tokens[xIdx]);
    const y = Number(tokens[yIdx]);
    const z = Number(tokens[zIdx]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    positions[written * 3] = x;
    positions[written * 3 + 1] = y;
    positions[written * 3 + 2] = z;
    if (x < bboxMinX) bboxMinX = x; if (x > bboxMaxX) bboxMaxX = x;
    if (y < bboxMinY) bboxMinY = y; if (y > bboxMaxY) bboxMaxY = y;
    if (z < bboxMinZ) bboxMinZ = z; if (z > bboxMaxZ) bboxMaxZ = z;
    if (intensitiesRaw) {
      const v = Number(tokens[iIdx]);
      const f = Number.isFinite(v) ? v : 0;
      intensitiesRaw[written] = f;
      if (f > intensityMax) intensityMax = f;
    }
    if (colorsRaw) {
      const r = Number(tokens[rIdx]);
      const g = Number(tokens[gIdx]);
      const b = Number(tokens[bIdx]);
      const rf = Number.isFinite(r) ? r : 0;
      const gf = Number.isFinite(g) ? g : 0;
      const bf = Number.isFinite(b) ? b : 0;
      colorsRaw[written * 3] = rf;
      colorsRaw[written * 3 + 1] = gf;
      colorsRaw[written * 3 + 2] = bf;
      const m = Math.max(rf, gf, bf);
      if (m > colorMax) colorMax = m;
    }
    written++;
  }

  // Trim if some lines got rejected.
  const trimmedPositions = written === dataLineCount ? positions : positions.subarray(0, written * 3);

  // Normalise intensity to u16 (0..65535). Detect 0..255 vs 0..1 vs
  // raw sensor by the observed maximum.
  let intensities: Uint16Array | undefined;
  if (intensitiesRaw) {
    intensities = new Uint16Array(written);
    const scale = intensityMax > 1.0
      ? (intensityMax > 255 ? 65535 / intensityMax : 65535 / 255)
      : 65535;
    for (let i = 0; i < written; i++) {
      const v = intensitiesRaw[i] * scale;
      intensities[i] = v < 0 ? 0 : v > 65535 ? 65535 : Math.round(v);
    }
  }

  // Normalise colour to 0..1 floats.
  let colors: Float32Array | undefined;
  if (colorsRaw) {
    colors = new Float32Array(written * 3);
    const scale = colorMax > 1.0 ? 1 / 255 : 1;
    for (let i = 0; i < written * 3; i++) {
      const v = colorsRaw[i] * scale;
      colors[i] = v < 0 ? 0 : v > 1 ? 1 : v;
    }
  }

  const bbox: PointCloudBBox = written === 0
    ? { min: [0, 0, 0], max: [0, 0, 0] }
    : { min: [bboxMinX, bboxMinY, bboxMinZ], max: [bboxMaxX, bboxMaxY, bboxMaxZ] };

  return {
    positions: written === dataLineCount ? positions : new Float32Array(trimmedPositions),
    colors,
    intensities,
    pointCount: written,
    bbox,
  };
}
