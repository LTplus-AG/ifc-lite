/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { Ray } from '@ifc-lite/renderer';
import type { RetainedPointCloudSample } from '@/hooks/ingest/pointCloudScanCache';
import type { ScanLandmark, ScanPoint, ScanRegistrationReport } from './types';
import { registeredPoint } from './landmarks';

/** The retained sample is Y-up and decode-relative (`pointCloudIngest`
 * swaps Z-up→Y-up before the reservoir sees a chunk). Landmarks and the
 * transfer payload use the file's own Z-up metres. */
export function nativePointFromSample(sample: Pick<RetainedPointCloudSample, 'positions' | 'origin'>, index: number): ScanPoint {
  const o = sample.origin ?? [0, 0, 0];
  const x = sample.positions[index * 3], yUp = sample.positions[index * 3 + 1], zBack = sample.positions[index * 3 + 2];
  return [x + o[0], -zBack + o[1], yUp + o[2]];
}
/** Inverse of {@link nativePointFromSample}: native Z-up metres into the preview's decode-relative Y-up frame. */
export function samplePointFromNative(origin: readonly [number, number, number] | null, point: ScanPoint): { x: number; y: number; z: number } {
  const o = origin ?? [0, 0, 0];
  return { x: point[0] - o[0], y: point[2] - o[2], z: -(point[1] - o[1]) };
}

/** Immutable snapshot of one streamed point cloud's retained sample, frozen
 * for a scan session: the reservoir is final once the model is registered,
 * and a re-load draws a different sample, so the session pins this copy. */
export interface ScanPointSource {
  handleId: number;
  count: number;
  /** Total points the reservoir saw; with `count` this describes the decimation. */
  seen: number;
  origin: readonly [number, number, number] | null;
  /** Decode-relative Y-up f32 positions, 3n, exactly as rendered. */
  positions: Float32Array;
  /** RGB8, 3n; neutral grey when the source carried no colour. */
  colors: Uint8Array;
  /** Distinguishes real RGB rows from the neutral snapshot fallback. */
  hadColors: boolean;
  /** Source-supplied decode-relative Y-up normals, 3n, or null when absent. */
  normals: Float32Array | null;
  /** The retained sample this snapshot was taken from, for identity checks. */
  retained: RetainedPointCloudSample;
}
export function snapshotPointSource(handleId: number, retained: RetainedPointCloudSample): ScanPointSource {
  if (retained.count < 4) throw new Error('The point cloud retained too few points to align. Reload it or choose another scan.');
  if (retained.count > 2_000_000) throw new Error('The retained point sample exceeds the 2,000,000-point transfer budget.');
  const positions = retained.positions.slice(0, retained.count * 3);
  const colors = retained.colors ? retained.colors.slice(0, retained.count * 3) : new Uint8Array(retained.count * 3).fill(200);
  const normals = retained.normals?.slice(0, retained.count * 3) ?? null;
  return { handleId, count: retained.count, seen: retained.seen, origin: retained.origin ? [...retained.origin] : null, positions, colors, hadColors: retained.colors !== null, normals, retained };
}
/** True while the snapshot still describes the live reservoir. */
export function samePointSource(snapshot: ScanPointSource, live: RetainedPointCloudSample | null): boolean {
  return live === snapshot.retained && live.count === snapshot.count && live.seen === snapshot.seen
    && (live.origin === null ? snapshot.origin === null : snapshot.origin !== null && live.origin.every((v, i) => v === snapshot.origin![i]))
    && equalPrefix(live.positions, snapshot.positions)
    && (live.colors === null ? !snapshot.hadColors && neutralColors(snapshot.colors) : snapshot.hadColors && equalPrefix(live.colors, snapshot.colors))
    && (live.normals === null ? snapshot.normals === null : snapshot.normals !== null && equalPrefix(live.normals, snapshot.normals));
}
function equalPrefix(live: ArrayLike<number>, frozen: ArrayLike<number>): boolean {
  if (live.length < frozen.length) return false;
  for (let i = 0; i < frozen.length; i++) if (!Object.is(live[i], frozen[i])) return false;
  return true;
}
function neutralColors(colors: Uint8Array): boolean {
  for (const value of colors) if (value !== 200) return false;
  return true;
}
/** Choose the planner orientation without silently ignoring malformed supplied normals. */
export function pointSourceOrientation(source: ScanPointSource): 'source-normals' | 'target-referenced' {
  if (!source.normals) return 'target-referenced';
  if (source.normals.length !== source.count * 3) throw new Error('The point cloud normal rows no longer match its retained points. Reload the scan.');
  for (let i = 0; i < source.count; i++) {
    const x = source.normals[i * 3], y = source.normals[i * 3 + 1], z = source.normals[i * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) || x * x + y * y + z * z === 0) {
      throw new Error(`PLY source normal ${i + 1} is missing, non-finite or zero. Repair the declared nx/ny/nz values before transferring appearance.`);
    }
  }
  return 'source-normals';
}
/** Native f64 positions, RGB8 colours and native Z-up normals for transfer. */
export function pointTransferPayload(source: ScanPointSource): { positions: Float64Array; colors: Uint8Array; normals: Float32Array } {
  const positions = new Float64Array(source.count * 3);
  for (let i = 0; i < source.count; i++) positions.set(nativePointFromSample(source, i), i * 3);
  const normals = source.normals ? new Float32Array(source.normals.length) : new Float32Array(0);
  if (source.normals) for (let i = 0; i < source.count; i++) {
    const x = source.normals[i * 3], y = -source.normals[i * 3 + 2], z = source.normals[i * 3 + 1];
    const length = Math.hypot(x, y, z);
    normals[i * 3] = x / length;
    normals[i * 3 + 1] = y / length;
    normals[i * 3 + 2] = z / length;
  }
  return { positions, colors: source.colors.slice(), normals };
}

/** Nearest retained point to a preview ray, in the preview's own frame:
 * among points within `tolerance(t)` of the ray (a screen-space radius grown
 * with depth), the one closest to the camera wins so a click lands on the
 * visible surface, not on a point behind it. Bounded linear scan. */
export function pickScanPoint(positions: Float32Array, count: number, ray: Ray, tolerance: (t: number) => number, offset: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 }): { index: number; t: number } | null {
  const { origin: o, direction: d } = ray;
  let best: { index: number; t: number; perpendicular: number } | null = null;
  for (let i = 0; i < count; i++) {
    const px = positions[i * 3] + offset.x - o.x, py = positions[i * 3 + 1] + offset.y - o.y, pz = positions[i * 3 + 2] + offset.z - o.z;
    const t = px * d.x + py * d.y + pz * d.z;
    if (t <= 0) continue;
    const perpendicular = Math.hypot(px - d.x * t, py - d.y * t, pz - d.z * t);
    if (perpendicular > tolerance(t)) continue;
    // Prefer the nearer point unless a farther one is much better centred.
    if (!best || t < best.t - tolerance(t) || (Math.abs(t - best.t) <= tolerance(t) && perpendicular < best.perpendicular)) best = { index: i, t, perpendicular };
  }
  return best && { index: best.index, t: best.t };
}
/** A landmark on a retained scan point, in native source metres. */
export function pointLandmark(source: ScanPointSource, index: number): ScanLandmark {
  if (!Number.isInteger(index) || index < 0 || index >= source.count) throw new Error('The picked scan point is no longer available.');
  return { kind: 'point', point: nativePointFromSample(source, index), index, observation: `point:${index}:seen:${source.seen}` };
}
/** Preview-frame position of a native landmark, aligned or not. */
export function pointPreviewPosition(source: ScanPointSource, report: ScanRegistrationReport | null, point: ScanPoint, isSource: boolean): { x: number; y: number; z: number } {
  if (report) {
    const p = isSource ? registeredPoint(report, point) : point;
    return { x: p[0] - report.targetAnchor[0], y: p[2] - report.targetAnchor[2], z: -(p[1] - report.targetAnchor[1]) };
  }
  return samplePointFromNative(source.origin, point);
}
/** Aligned preview: every retained point through the fitted transform, about the target anchor. */
export function alignedPointPreview(source: ScanPointSource, report: ScanRegistrationReport): Float32Array {
  const positions = new Float32Array(source.count * 3);
  for (let i = 0; i < source.count; i++) {
    const p = pointPreviewPosition(source, report, nativePointFromSample(source, i), true);
    positions[i * 3] = p.x; positions[i * 3 + 1] = p.y; positions[i * 3 + 2] = p.z;
  }
  return positions;
}
