/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Session-level report routing tests (#1760 review findings). Node's
 * EventTarget stands in for a HIDDevice; `navigator.hid` is absent here, which
 * the session already tolerates. The load-bearing property: reports the
 * device's layout does not map must NOT refresh the input timestamp, or a
 * periodic status report would keep an earlier deflection latched past the
 * staleness watchdog and drive the camera forever.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpaceMouseSession } from './device.js';

const GD = 0x01 << 16;
const [X, Y, Z] = [GD | 0x30, GD | 0x31, GD | 0x32];

interface FakeDeviceInit {
  collections?: unknown[];
}

function fakeDevice({ collections = [] }: FakeDeviceInit = {}): HIDDevice {
  const device = new EventTarget() as unknown as Record<string, unknown>;
  device.vendorId = 0x256f;
  device.productId = 0xc635;
  device.productName = 'Fake';
  device.opened = true;
  device.collections = collections;
  device.open = async () => {};
  device.close = async () => {};
  return device as unknown as HIDDevice;
}

function send(device: HIDDevice, reportId: number, bytes: number[]): void {
  const event = new Event('inputreport') as Event & {
    reportId: number;
    data: DataView;
    device: HIDDevice;
  };
  event.reportId = reportId;
  event.data = new DataView(new Uint8Array(bytes).buffer);
  event.device = device;
  (device as unknown as EventTarget).dispatchEvent(event);
}

/** Descriptor naming X, Y, Z as 16-bit +/-350 fields in report 1. */
function xyzCollections(): unknown[] {
  return [{
    usagePage: 0x01,
    usage: 0x08,
    inputReports: [{
      reportId: 1,
      items: [{
        usages: [X, Y, Z],
        reportSize: 16,
        reportCount: 3,
        logicalMinimum: -350,
        logicalMaximum: 350,
      }],
    }],
  }];
}

test('descriptor device: mapped report updates state and timestamp', () => {
  const device = fakeDevice({ collections: xyzCollections() });
  const session = new SpaceMouseSession(device, {});
  assert.equal(session.getLastSampleAt(), Number.NEGATIVE_INFINITY);
  send(device, 1, [0x64, 0x00, 0x00, 0x00, 0x00, 0x00]); // tx = 100
  assert.equal(session.getState().tx, 100);
  assert.ok(Number.isFinite(session.getLastSampleAt()));
  session.detach();
});

test('descriptor device: unmapped report id neither moves axes nor refreshes the watchdog', () => {
  const device = fakeDevice({ collections: xyzCollections() });
  const session = new SpaceMouseSession(device, {});
  send(device, 1, [0x64, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const sampleAt = session.getLastSampleAt();
  // A status/vendor report the descriptor does not map, with bytes that the
  // legacy parser would happily decode as rotation.
  send(device, 2, [0x2c, 0x01, 0x00, 0x00, 0x00, 0x00]);
  send(device, 23, [0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  assert.deepEqual(session.getState(), { tx: 100, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 });
  assert.equal(session.getLastSampleAt(), sampleAt, 'unmapped reports must not feed the watchdog');
  session.detach();
});

test('legacy device: only the known motion report ids refresh the watchdog', () => {
  const device = fakeDevice(); // no descriptor: legacy fixed layout
  const session = new SpaceMouseSession(device, {});
  send(device, 1, [0x64, 0x00, 0x00, 0x00, 0x00, 0x00]);
  assert.equal(session.getState().tx, 100);
  const sampleAt = session.getLastSampleAt();
  send(device, 9, [0x01, 0x02, 0x03, 0x04]); // unknown vendor report
  assert.equal(session.getLastSampleAt(), sampleAt);
  send(device, 2, [0x00, 0x00, 0x2c, 0x01, 0x00, 0x00]); // rotation: ry = 300
  assert.equal(session.getState().ry, 300);
  assert.ok(session.getLastSampleAt() >= sampleAt);
  session.detach();
});

test('buttons report fires the fit callback on press edges, never motion', () => {
  const device = fakeDevice({ collections: xyzCollections() });
  let fits = 0;
  const session = new SpaceMouseSession(device, { onFitButton: () => { fits++; } });
  send(device, 1, [0x64, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const sampleAt = session.getLastSampleAt();
  send(device, 3, [0x01]); // button 0 down
  send(device, 3, [0x01]); // held: no second edge
  send(device, 3, [0x00]); // released
  send(device, 3, [0x01]); // pressed again
  assert.equal(fits, 2);
  assert.deepEqual(session.getState().tx, 100);
  assert.equal(session.getLastSampleAt(), sampleAt);
  session.detach();
});
