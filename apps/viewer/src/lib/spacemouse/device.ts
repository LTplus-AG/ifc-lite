/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * WebHID connection management for 3Dconnexion SpaceMouse devices.
 *
 * Owns the browser-facing half of the driver: permission prompt, opening the
 * device, decoding `inputreport` events through the pure parser, button edge
 * detection, and reconnecting a previously granted device without a prompt
 * (WebHID persists grants per origin). The consumer polls `getState()` from
 * its own animation frame; nothing here touches the camera.
 *
 * WebHID exists in Chromium-based browsers only, and requires a user gesture
 * for `requestDevice`. A running 3DxWare driver can hold the device
 * exclusively, in which case `open()` fails; we surface that as a friendly
 * error rather than a silent no-op.
 */

import {
  FIT_BUTTON_INDICES,
  HID_USAGE_MULTI_AXIS_CONTROLLER,
  HID_USAGE_PAGE_GENERIC_DESKTOP,
  REPORT_ID_BUTTONS,
  REPORT_ID_ROTATION,
  REPORT_ID_TRANSLATION,
  SPACEMOUSE_VENDOR_IDS,
} from './constants.js';
import {
  buildDeviceLayout,
  layoutAxisCount,
  parseReportWithLayout,
  type DeviceLayout,
} from './descriptor.js';
import { parseButtonsReport, parseSpaceMouseReport, zeroSixDof, type SixDof } from './parser.js';

/** True when the browser exposes WebHID (Chromium-based browsers). */
export function isWebHidSupported(): boolean {
  return typeof navigator !== 'undefined' && navigator.hid !== undefined;
}

/**
 * Device picker filters. Restricting to the Multi-axis Controller usage keeps
 * ordinary Logitech mice/keyboards (same 0x046d vendor id) out of the chooser;
 * 0x256f is 3Dconnexion-exclusive so a bare vendor filter is safe there and
 * also catches devices whose top-level collection reports a different usage.
 */
const REQUEST_FILTERS: HIDDeviceFilter[] = [
  ...SPACEMOUSE_VENDOR_IDS.map((vendorId) => ({
    vendorId,
    usagePage: HID_USAGE_PAGE_GENERIC_DESKTOP,
    usage: HID_USAGE_MULTI_AXIS_CONTROLLER,
  })),
  { vendorId: 0x256f },
];

function isSpaceMouseCandidate(device: HIDDevice): boolean {
  return (SPACEMOUSE_VENDOR_IDS as readonly number[]).includes(device.vendorId);
}

/**
 * Rank candidate HID interfaces: a physical device can expose several (LEDs,
 * consumer controls); the one with the Multi-axis Controller collection is
 * the 6DoF stream.
 */
function multiAxisScore(device: HIDDevice): number {
  const collections = device.collections ?? [];
  // Descriptor-named 6DoF axes outrank the bare Multi-axis Controller usage:
  // the interface that actually carries X..RZ is the one we want to open.
  const layout = buildDeviceLayout(collections);
  if (layout) return 1 + layoutAxisCount(layout);
  return collections.some(
    (c) => c.usagePage === HID_USAGE_PAGE_GENERIC_DESKTOP && c.usage === HID_USAGE_MULTI_AXIS_CONTROLLER,
  ) ? 1 : 0;
}

/** 0x-prefixed hex string for ids/usages in the diagnostics dump. */
function hex(value: number, width = 4): string {
  return `0x${(value >>> 0).toString(16).padStart(width, '0')}`;
}

/** Per-report tally + last payload, for the diagnostics view. */
export interface ReportTrace {
  reportId: number;
  count: number;
  byteLength: number;
  /** Last payload as space-separated hex bytes (report-id byte stripped). */
  lastBytesHex: string;
}

/** Snapshot of everything the panel diagnostics section renders. */
export interface SpaceMouseDiagnostics {
  productName: string;
  vendorId: number;
  productId: number;
  /** 'descriptor' when the HID report descriptor drives parsing, else 'legacy'. */
  layoutSource: 'descriptor' | 'legacy';
  /** Number of 6DoF axes the descriptor names (0 on the legacy path). */
  layoutAxes: number;
  /** Latest decoded sample, device counts rescaled to [-350, 350]. */
  axes: SixDof;
  /** performance.now() of the last decoded 6DoF report, -Infinity before one. */
  lastSampleAt: number;
  buttonsDown: number[];
  /** Per-report-id traces, ascending by report id. */
  reports: ReportTrace[];
  /** Full JSON dump (device + descriptor + recent reports) for bug reports. */
  buildDump: () => string;
}

export interface SpaceMouseSessionOptions {
  /** Called on every decoded 6DoF sample (high frequency; keep it cheap). */
  onSample?: (state: SixDof) => void;
  /** Called once per press (edge) of a fit-mapped device button. */
  onFitButton?: () => void;
  /** Called when the device goes away (unplugged or closed by the browser). */
  onDisconnect?: () => void;
}

/**
 * One open SpaceMouse device. Create via `connectSpaceMouse` /
 * `reconnectGrantedSpaceMouse`; call `close()` on teardown.
 */
export class SpaceMouseSession {
  private state: SixDof = zeroSixDof();
  private lastSampleAt = Number.NEGATIVE_INFINITY;
  private buttonsDown = new Set<number>();
  private closed = false;
  /** Descriptor-derived axis layout, or null to use the legacy fixed layout. */
  private readonly layout: DeviceLayout | null;
  private readonly reportTraces = new Map<number, ReportTrace>();

  private trace(reportId: number, data: DataView): void {
    let entry = this.reportTraces.get(reportId);
    if (!entry) {
      entry = { reportId, count: 0, byteLength: 0, lastBytesHex: '' };
      this.reportTraces.set(reportId, entry);
    }
    entry.count++;
    entry.byteLength = data.byteLength;
    const bytes: string[] = [];
    for (let i = 0; i < data.byteLength; i++) {
      bytes.push(data.getUint8(i).toString(16).padStart(2, '0'));
    }
    entry.lastBytesHex = bytes.join(' ');
  }

  private readonly handleInputReport = (event: HIDInputReportEvent): void => {
    this.trace(event.reportId, event.data);

    // Buttons: the report id the descriptor names, or the classic 3 when the
    // descriptor is silent. A report that carries axes is never buttons.
    const axisFields = this.layout?.reports.get(event.reportId);
    const buttonsId = this.layout?.buttonsReportId ?? REPORT_ID_BUTTONS;
    if (!axisFields && event.reportId === buttonsId) {
      const pressed = parseButtonsReport(event.data);
      const now = new Set(pressed);
      for (const index of pressed) {
        if (!this.buttonsDown.has(index) && FIT_BUTTON_INDICES.has(index)) {
          this.options.onFitButton?.();
        }
      }
      this.buttonsDown = now;
      return;
    }

    // 6DoF: descriptor-derived fields when the descriptor covers this report,
    // legacy fixed offsets when there is no usable descriptor (also the
    // fake-device path in e2e tests). Reports neither path understands are
    // dropped WITHOUT refreshing lastSampleAt: a periodic status report must
    // not keep an earlier deflection latched past the staleness watchdog.
    if (axisFields) {
      this.state = parseReportWithLayout(axisFields, event.data, this.state);
    } else if (this.layout) {
      return; // descriptor is authoritative: unmapped report id, not motion
    } else if (event.reportId === REPORT_ID_TRANSLATION || event.reportId === REPORT_ID_ROTATION) {
      this.state = parseSpaceMouseReport(event.reportId, event.data, this.state);
    } else {
      return;
    }
    this.lastSampleAt = performance.now();
    this.options.onSample?.(this.state);
  };

  private readonly handleGlobalDisconnect = (event: HIDConnectionEvent): void => {
    if (event.device === this.device) {
      void this.close();
    }
  };

  constructor(
    readonly device: HIDDevice,
    private readonly options: SpaceMouseSessionOptions,
  ) {
    this.layout = buildDeviceLayout(device.collections);
    device.addEventListener('inputreport', this.handleInputReport);
    navigator.hid?.addEventListener('disconnect', this.handleGlobalDisconnect);
  }

  /** Latest decoded 6DoF sample (device counts, clamped). */
  getState(): SixDof {
    return this.state;
  }

  /**
   * performance.now() of the last decoded 6DoF report, -Infinity before the
   * first one. Feed to `isInputStale` so a silent HID stall (no disconnect
   * event) cannot latch the last sample and drive the camera forever.
   */
  getLastSampleAt(): number {
    return this.lastSampleAt;
  }

  get productName(): string {
    return this.device.productName || 'SpaceMouse';
  }

  /** Snapshot for the panel diagnostics section (cheap; poll at UI rate). */
  getDiagnostics(): SpaceMouseDiagnostics {
    return {
      productName: this.productName,
      vendorId: this.device.vendorId,
      productId: this.device.productId,
      layoutSource: this.layout ? 'descriptor' : 'legacy',
      layoutAxes: this.layout ? layoutAxisCount(this.layout) : 0,
      axes: { ...this.state },
      lastSampleAt: this.lastSampleAt,
      buttonsDown: [...this.buttonsDown].sort((a, b) => a - b),
      reports: [...this.reportTraces.values()].sort((a, b) => a.reportId - b.reportId),
      buildDump: () => this.buildDump(),
    };
  }

  /**
   * Human-postable JSON describing the device: ids, the HID report descriptor
   * as the browser sees it, the derived layout and the recent report traffic.
   * This is what we ask users to paste into an issue when motion is wrong on
   * hardware we cannot test against.
   */
  private buildDump(): string {
    const describeCollection = (c: HIDCollectionInfo): unknown => ({
      usagePage: hex(c.usagePage),
      usage: hex(c.usage),
      inputReports: (c.inputReports ?? []).map((r) => ({
        reportId: r.reportId ?? 0,
        items: (r.items ?? []).map((item) => ({
          usages: item.isRange
            ? `range ${hex(item.usageMinimum ?? 0, 8)}..${hex(item.usageMaximum ?? 0, 8)}`
            : (item.usages ?? []).map((u) => hex(u, 8)),
          reportSize: item.reportSize,
          reportCount: item.reportCount,
          logicalMin: item.logicalMinimum,
          logicalMax: item.logicalMaximum,
          ...(item.isConstant ? { isConstant: true } : {}),
        })),
      })),
      ...(c.children && c.children.length > 0
        ? { children: c.children.map(describeCollection) }
        : {}),
    });

    return JSON.stringify(
      {
        product: this.productName,
        vendorId: hex(this.device.vendorId),
        productId: hex(this.device.productId),
        layoutSource: this.layout ? 'descriptor' : 'legacy',
        derivedLayout: this.layout
          ? [...this.layout.reports.entries()].map(([reportId, fields]) => ({
              reportId,
              axes: fields.map((f) => ({
                axis: f.axis,
                bitOffset: f.bitOffset,
                bitSize: f.bitSize,
                logicalMin: f.logicalMinimum,
                logicalMax: f.logicalMaximum,
              })),
            }))
          : null,
        buttonsReportId: this.layout?.buttonsReportId ?? null,
        reportsSeen: [...this.reportTraces.values()].sort((a, b) => a.reportId - b.reportId),
        lastAxes: this.state,
        collections: (this.device.collections ?? []).map(describeCollection),
      },
      null,
      2,
    );
  }

  /**
   * Detach listeners WITHOUT closing the device or firing onDisconnect. For
   * discarding a duplicate session whose underlying device another session
   * still streams from (overlapping connect attempts can wrap the same
   * HIDDevice). Safe to call more than once.
   */
  detach(): void {
    if (this.closed) return;
    this.closed = true;
    this.state = zeroSixDof();
    this.device.removeEventListener('inputreport', this.handleInputReport);
    navigator.hid?.removeEventListener('disconnect', this.handleGlobalDisconnect);
  }

  /** Close the device and detach listeners. Safe to call more than once. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.detach();
    try {
      await this.device.close();
    } catch { /* already closed / gone */ }
    this.options.onDisconnect?.();
  }
}

async function openSession(devices: HIDDevice[], options: SpaceMouseSessionOptions): Promise<SpaceMouseSession> {
  const candidates = devices
    .filter(isSpaceMouseCandidate)
    .sort((a, b) => multiAxisScore(b) - multiAxisScore(a));
  if (candidates.length === 0) {
    throw new Error('No SpaceMouse found.');
  }

  let lastError: unknown = null;
  for (const device of candidates) {
    try {
      if (!device.opened) await device.open();
      return new SpaceMouseSession(device, options);
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(
    'Could not open the SpaceMouse. If the 3Dconnexion driver (3DxWare) is running it may hold the device; quit it and reconnect.'
    + (lastError ? ` (${String(lastError)})` : ''),
  );
}

/**
 * Prompt the user to pick a SpaceMouse and open it. Must be called from a user
 * gesture (click). Throws with a human-readable message on failure; resolves
 * null if the user dismissed the chooser.
 */
export async function connectSpaceMouse(options: SpaceMouseSessionOptions): Promise<SpaceMouseSession | null> {
  if (!navigator.hid) throw new Error('WebHID is not available in this browser.');
  const devices = await navigator.hid.requestDevice({ filters: REQUEST_FILTERS });
  if (devices.length === 0) return null; // user cancelled the picker
  return openSession(devices, options);
}

/**
 * Silently reopen a device the user granted in an earlier session, if any.
 * Never prompts; returns null when nothing was granted or opening fails
 * (e.g. the device is unplugged), so startup stays quiet.
 */
export async function reconnectGrantedSpaceMouse(options: SpaceMouseSessionOptions): Promise<SpaceMouseSession | null> {
  if (!navigator.hid) return null;
  try {
    const devices = await navigator.hid.getDevices();
    if (!devices.some(isSpaceMouseCandidate)) return null;
    return await openSession(devices, options);
  } catch {
    return null;
  }
}
