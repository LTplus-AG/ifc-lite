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
  SPACEMOUSE_VENDOR_IDS,
} from './constants.js';
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
  return collections.some(
    (c) => c.usagePage === HID_USAGE_PAGE_GENERIC_DESKTOP && c.usage === HID_USAGE_MULTI_AXIS_CONTROLLER,
  ) ? 1 : 0;
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

  private readonly handleInputReport = (event: HIDInputReportEvent): void => {
    if (event.reportId === REPORT_ID_BUTTONS) {
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
    this.state = parseSpaceMouseReport(event.reportId, event.data, this.state);
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
