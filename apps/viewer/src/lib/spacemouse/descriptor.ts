/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * HID report-descriptor driven axis layout for 3Dconnexion devices.
 *
 * The legacy parser (parser.ts) hard-codes the classic SpaceNavigator layout
 * (reportId 1 = three int16 translations, reportId 2 = rotations, >=12 bytes =
 * combined). Real hardware disagrees: hardware feedback on #1677 showed a
 * device where only one axis did anything, because its reports do not match
 * those byte offsets. WebHID exposes the device's own report descriptor via
 * `HIDDevice.collections`, which names every axis (Generic Desktop X..RZ) with
 * its exact bit offset, width and logical range, so instead of guessing we
 * read the layout the device declares:
 *
 *   - any report split (translation/rotation separate, combined, or per-axis)
 *   - any field width (8/16/32-bit, even unaligned bit fields)
 *   - any axis order, interleaved padding, leading constant fields
 *   - the device's true full-scale (logicalMax varies: 350, 511, 32767...)
 *
 * Values are rescaled to the legacy AXIS_FULL_SCALE window so the downstream
 * mapping (dead zone, sensitivity) is unchanged. Devices whose descriptor
 * exposes no axes (or fake test devices) fall back to the legacy parser,
 * per report id.
 */

import { AXIS_FULL_SCALE } from './constants.js';
import { clampAxis, type SixDof } from './parser.js';

/** Generic Desktop usage page and its 6DoF axis usage ids. */
const USAGE_PAGE_GENERIC_DESKTOP = 0x01;
const USAGE_PAGE_BUTTON = 0x09;

/** Extended usage (page << 16 | id) -> SixDof axis key. X..RZ = 0x30..0x35. */
const AXIS_BY_USAGE: ReadonlyMap<number, keyof SixDof> = new Map([
  [(USAGE_PAGE_GENERIC_DESKTOP << 16) | 0x30, 'tx'],
  [(USAGE_PAGE_GENERIC_DESKTOP << 16) | 0x31, 'ty'],
  [(USAGE_PAGE_GENERIC_DESKTOP << 16) | 0x32, 'tz'],
  [(USAGE_PAGE_GENERIC_DESKTOP << 16) | 0x33, 'rx'],
  [(USAGE_PAGE_GENERIC_DESKTOP << 16) | 0x34, 'ry'],
  [(USAGE_PAGE_GENERIC_DESKTOP << 16) | 0x35, 'rz'],
]);

/** One axis field inside an input report, located by bit position. */
export interface AxisField {
  axis: keyof SixDof;
  /** Bit offset inside the report payload (report-id byte already stripped). */
  bitOffset: number;
  bitSize: number;
  logicalMinimum: number;
  logicalMaximum: number;
}

/** Axis layout of one device, derived from its HID report descriptor. */
export interface DeviceLayout {
  /** reportId -> axis fields carried by that report. */
  reports: ReadonlyMap<number, readonly AxisField[]>;
  /** reportId whose items include Button-page usages, or null if none found. */
  buttonsReportId: number | null;
}

/** Total number of axis fields in a layout (a 6DoF device yields 6). */
export function layoutAxisCount(layout: DeviceLayout): number {
  let count = 0;
  for (const fields of layout.reports.values()) count += fields.length;
  return count;
}

/**
 * Derive the axis layout from a device's HID collections. Returns null when
 * the descriptor names fewer than three axes (nothing trustworthy to drive a
 * camera with) so callers fall back to the legacy fixed layout. Never throws
 * on malformed descriptor data.
 */
export function buildDeviceLayout(collections: readonly HIDCollectionInfo[] | undefined): DeviceLayout | null {
  if (!collections || collections.length === 0) return null;

  const reports = new Map<number, AxisField[]>();
  let buttonsReportId: number | null = null;

  // Chrome lists one HIDReportInfo per (collection, reportId); a report split
  // across nested collections appears once per collection, in document order,
  // so a single bit cursor per reportId reconstructs the payload layout.
  const bitCursor = new Map<number, number>();

  const visit = (collection: HIDCollectionInfo): void => {
    for (const report of collection.inputReports ?? []) {
      const reportId = report.reportId ?? 0;
      let offset = bitCursor.get(reportId) ?? 0;
      for (const item of report.items ?? []) {
        const size = item.reportSize ?? 0;
        const count = item.reportCount ?? 0;
        if (size <= 0 || count <= 0 || size > 64) {
          continue; // malformed item: no bits to account for
        }
        if (!item.isConstant) {
          for (let i = 0; i < count; i++) {
            const usage = usageForIndex(item, i);
            if (usage === null) continue;
            const page = usage >>> 16;
            if (page === USAGE_PAGE_BUTTON && buttonsReportId === null) {
              buttonsReportId = reportId;
              continue;
            }
            const axis = AXIS_BY_USAGE.get(usage);
            if (!axis) continue;
            const fields = reports.get(reportId) ?? [];
            fields.push({
              axis,
              bitOffset: offset + i * size,
              bitSize: size,
              logicalMinimum: item.logicalMinimum ?? 0,
              logicalMaximum: item.logicalMaximum ?? 0,
            });
            reports.set(reportId, fields);
          }
        }
        offset += size * count;
      }
      bitCursor.set(reportId, offset);
    }
    for (const child of collection.children ?? []) visit(child);
  };

  try {
    for (const collection of collections) visit(collection);
  } catch {
    return null; // hostile / malformed descriptor object: use the legacy path
  }

  const layout: DeviceLayout = { reports, buttonsReportId };
  return layoutAxisCount(layout) >= 3 ? layout : null;
}

/** Extended usage of the `index`-th element of an item, or null. */
function usageForIndex(item: HIDReportItem, index: number): number | null {
  if (item.isRange) {
    const min = item.usageMinimum;
    const max = item.usageMaximum;
    if (typeof min !== 'number') return null;
    const usage = min + index;
    return typeof max === 'number' && usage > max ? null : usage;
  }
  const usages = item.usages;
  if (!usages || usages.length === 0) return null;
  // Fewer usages than reportCount: HID repeats the last one.
  return usages[Math.min(index, usages.length - 1)] ?? null;
}

/**
 * Read one little-endian bit field from a report payload. Returns null when
 * the report is too short (truncated) or the field is unreadable, so the
 * caller keeps the previous axis value. Sign-extends when the descriptor's
 * logical range is signed.
 */
export function readAxisField(data: DataView, field: AxisField): number | null {
  const { bitOffset, bitSize } = field;
  if (bitSize <= 0 || bitOffset < 0) return null;
  if (bitOffset + bitSize > data.byteLength * 8) return null;
  const signed = field.logicalMinimum < 0;

  let raw: number;
  if (bitOffset % 8 === 0 && bitSize === 8) {
    raw = signed ? data.getInt8(bitOffset / 8) : data.getUint8(bitOffset / 8);
  } else if (bitOffset % 8 === 0 && bitSize === 16) {
    raw = signed ? data.getInt16(bitOffset / 8, true) : data.getUint16(bitOffset / 8, true);
  } else if (bitOffset % 8 === 0 && bitSize === 32) {
    raw = signed ? data.getInt32(bitOffset / 8, true) : data.getUint32(bitOffset / 8, true);
  } else if (bitSize < 32) {
    // Generic unaligned little-endian bit extraction.
    let value = 0;
    for (let i = 0; i < bitSize; i++) {
      const bit = bitOffset + i;
      if ((data.getUint8(bit >> 3) >> (bit & 7)) & 1) value += 2 ** i;
    }
    if (signed && value >= 2 ** (bitSize - 1)) value -= 2 ** bitSize;
    raw = value;
  } else {
    return null; // unaligned >=32-bit fields do not occur on real devices
  }

  // Rescale the device's declared range to the legacy AXIS_FULL_SCALE window
  // so dead zone and rates keep meaning the same thing on every device.
  // Centre on the logical midpoint first: an unsigned 0..700 axis rests at
  // 350, and scaling it around zero instead would read as constant drift.
  if (!Number.isFinite(raw)) return 0;
  const halfRange = (field.logicalMaximum - field.logicalMinimum) / 2;
  if (halfRange > 0) {
    const center = (field.logicalMinimum + field.logicalMaximum) / 2;
    raw = ((raw - center) / halfRange) * AXIS_FULL_SCALE;
  }
  return clampAxis(raw);
}

/**
 * Fold one report into a 6DoF state using the descriptor-derived fields for
 * its report id. Pure; axes not carried by this report (or truncated away)
 * keep their previous value.
 */
export function parseReportWithLayout(
  fields: readonly AxisField[],
  data: DataView,
  prev: SixDof,
): SixDof {
  const next: SixDof = { ...prev };
  for (const field of fields) {
    const value = readAxisField(data, field);
    if (value !== null) next[field.axis] = value;
  }
  return next;
}
