/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Minimal WebHID type definitions.
 *
 * WebHID is a browser API (Chromium only) that the TypeScript DOM lib does not
 * yet ship. We declare only the slice we use for 3Dconnexion SpaceMouse
 * navigation so the code type-checks without pulling in a third-party @types
 * package. Everything here is guarded behind a runtime `navigator.hid` check.
 */

interface HIDDeviceFilter {
  vendorId?: number;
  productId?: number;
  usagePage?: number;
  usage?: number;
}

interface HIDDeviceRequestOptions {
  filters: HIDDeviceFilter[];
}

interface HIDReportItem {
  readonly isAbsolute?: boolean;
  readonly isArray?: boolean;
  readonly isConstant?: boolean;
  readonly isRange?: boolean;
  /** Extended usages: (usagePage << 16) | usageId, one per report element. */
  readonly usages?: readonly number[];
  readonly usageMinimum?: number;
  readonly usageMaximum?: number;
  readonly reportSize?: number;
  readonly reportCount?: number;
  readonly logicalMinimum?: number;
  readonly logicalMaximum?: number;
}

interface HIDReportInfo {
  readonly reportId?: number;
  readonly items?: readonly HIDReportItem[];
}

interface HIDCollectionInfo {
  readonly usagePage: number;
  readonly usage: number;
  readonly children?: readonly HIDCollectionInfo[];
  readonly inputReports?: readonly HIDReportInfo[];
}

interface HIDInputReportEvent extends Event {
  readonly device: HIDDevice;
  readonly reportId: number;
  /** Report payload with the leading report-id byte already stripped. */
  readonly data: DataView;
}

interface HIDDeviceEventMap {
  inputreport: HIDInputReportEvent;
}

interface HIDDevice extends EventTarget {
  readonly opened: boolean;
  readonly vendorId: number;
  readonly productId: number;
  readonly productName: string;
  readonly collections: readonly HIDCollectionInfo[];
  open(): Promise<void>;
  close(): Promise<void>;
  addEventListener<K extends keyof HIDDeviceEventMap>(
    type: K,
    listener: (this: HIDDevice, ev: HIDDeviceEventMap[K]) => unknown,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener<K extends keyof HIDDeviceEventMap>(
    type: K,
    listener: (this: HIDDevice, ev: HIDDeviceEventMap[K]) => unknown,
    options?: boolean | EventListenerOptions,
  ): void;
}

interface HIDConnectionEvent extends Event {
  readonly device: HIDDevice;
}

interface HIDEventMap {
  connect: HIDConnectionEvent;
  disconnect: HIDConnectionEvent;
}

interface HID extends EventTarget {
  getDevices(): Promise<HIDDevice[]>;
  requestDevice(options: HIDDeviceRequestOptions): Promise<HIDDevice[]>;
  addEventListener<K extends keyof HIDEventMap>(
    type: K,
    listener: (this: HID, ev: HIDEventMap[K]) => unknown,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener<K extends keyof HIDEventMap>(
    type: K,
    listener: (this: HID, ev: HIDEventMap[K]) => unknown,
    options?: boolean | EventListenerOptions,
  ): void;
}

interface Navigator {
  readonly hid?: HID;
}
