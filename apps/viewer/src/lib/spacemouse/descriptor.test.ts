/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for the HID report-descriptor driven axis layout (#1677 hardware
 * follow-up). Each case models a real 3Dconnexion descriptor shape: the
 * classic split-report SpaceNavigator, combined-report devices, different
 * logical ranges, 8-bit and unaligned fields, padding, rotation-first
 * ordering, and nested collections.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDeviceLayout,
  layoutAxisCount,
  parseReportWithLayout,
  readAxisField,
  type AxisField,
} from './descriptor.js';
import { zeroSixDof } from './parser.js';
import { AXIS_FULL_SCALE } from './constants.js';

const GD = 0x01 << 16; // Generic Desktop usage page, extended-usage high bits
const BTN = 0x09 << 16; // Button usage page
const [X, Y, Z, RX, RY, RZ] = [GD | 0x30, GD | 0x31, GD | 0x32, GD | 0x33, GD | 0x34, GD | 0x35];

function axisItem(usages: number[], opts: Partial<HIDReportItem> = {}): HIDReportItem {
  return {
    usages,
    reportSize: 16,
    reportCount: usages.length,
    logicalMinimum: -350,
    logicalMaximum: 350,
    ...opts,
  };
}

/** DataView of int16 LE values. */
function i16(values: number[]): DataView {
  const view = new DataView(new ArrayBuffer(values.length * 2));
  values.forEach((v, i) => view.setInt16(i * 2, v, true));
  return view;
}

function bytes(values: number[]): DataView {
  return new DataView(new Uint8Array(values).buffer);
}

/** Classic SpaceNavigator: report 1 = XYZ, report 2 = RxRyRz, report 3 = buttons. */
function splitCollections(): HIDCollectionInfo[] {
  return [{
    usagePage: 0x01,
    usage: 0x08,
    inputReports: [
      { reportId: 1, items: [axisItem([X, Y, Z])] },
      { reportId: 2, items: [axisItem([RX, RY, RZ])] },
      {
        reportId: 3,
        items: [{
          isRange: true,
          usageMinimum: BTN | 1,
          usageMaximum: BTN | 2,
          reportSize: 1,
          reportCount: 2,
          logicalMinimum: 0,
          logicalMaximum: 1,
        }],
      },
    ],
  }];
}

test('split-report descriptor maps both reports and the buttons id', () => {
  const layout = buildDeviceLayout(splitCollections());
  assert.ok(layout);
  assert.equal(layoutAxisCount(layout), 6);
  assert.equal(layout.buttonsReportId, 3);

  const t = layout.reports.get(1);
  assert.ok(t);
  assert.deepEqual(t.map((f) => [f.axis, f.bitOffset]), [['tx', 0], ['ty', 16], ['tz', 32]]);

  const state = parseReportWithLayout(t, i16([5, -6, 7]), zeroSixDof());
  assert.equal(state.tx, 5);
  assert.equal(state.ty, -6);
  assert.equal(state.tz, 7);

  const r = layout.reports.get(2);
  assert.ok(r);
  const state2 = parseReportWithLayout(r, i16([-9, 10, -11]), state);
  assert.deepEqual(state2, { tx: 5, ty: -6, tz: 7, rx: -9, ry: 10, rz: -11 });
});

test('combined-report descriptor maps all six axes in one report', () => {
  const layout = buildDeviceLayout([{
    usagePage: 0x01,
    usage: 0x08,
    inputReports: [{ reportId: 1, items: [axisItem([X, Y, Z, RX, RY, RZ])] }],
  }]);
  assert.ok(layout);
  const fields = layout.reports.get(1);
  assert.ok(fields);
  assert.equal(fields.length, 6);
  const state = parseReportWithLayout(fields, i16([1, 2, 3, 4, 5, 6]), zeroSixDof());
  assert.deepEqual(state, { tx: 1, ty: 2, tz: 3, rx: 4, ry: 5, rz: 6 });
});

test('a wider logical range rescales to the legacy full-scale window', () => {
  const layout = buildDeviceLayout([{
    usagePage: 0x01,
    usage: 0x08,
    inputReports: [{
      reportId: 1,
      items: [axisItem([X, Y, Z], { logicalMinimum: -511, logicalMaximum: 511 })],
    }],
  }]);
  assert.ok(layout);
  const fields = layout.reports.get(1);
  assert.ok(fields);
  const state = parseReportWithLayout(fields, i16([511, -511, 0]), zeroSixDof());
  assert.equal(state.tx, AXIS_FULL_SCALE);
  assert.equal(state.ty, -AXIS_FULL_SCALE);
  assert.equal(state.tz, 0);
});

test('8-bit combined report parses per byte (the legacy int16 reader cannot)', () => {
  // A 6-byte, six-axis 8-bit report: read as int16 pairs this smears one
  // physical axis across two logical ones, which is exactly the class of bug
  // the descriptor path exists to fix.
  const layout = buildDeviceLayout([{
    usagePage: 0x01,
    usage: 0x08,
    inputReports: [{
      reportId: 1,
      items: [axisItem([X, Y, Z, RX, RY, RZ], { reportSize: 8, logicalMinimum: -127, logicalMaximum: 127 })],
    }],
  }]);
  assert.ok(layout);
  const fields = layout.reports.get(1);
  assert.ok(fields);
  // Tilt only: rx = -64 (0xc0 signed), everything else at rest.
  const state = parseReportWithLayout(fields, bytes([0, 0, 0, 0xc0, 0, 0]), zeroSixDof());
  assert.equal(Math.round(state.rx), Math.round((-64 / 127) * AXIS_FULL_SCALE));
  assert.equal(state.tx, 0);
  assert.equal(state.ty, 0);
  assert.equal(state.tz, 0);
});

test('rotation-first report ordering follows the descriptor, not convention', () => {
  const layout = buildDeviceLayout([{
    usagePage: 0x01,
    usage: 0x08,
    inputReports: [
      { reportId: 1, items: [axisItem([RX, RY, RZ])] },
      { reportId: 2, items: [axisItem([X, Y, Z])] },
    ],
  }]);
  assert.ok(layout);
  const fields = layout.reports.get(1);
  assert.ok(fields);
  const state = parseReportWithLayout(fields, i16([40, 50, 60]), zeroSixDof());
  assert.deepEqual(state, { tx: 0, ty: 0, tz: 0, rx: 40, ry: 50, rz: 60 });
});

test('constant padding before the axes shifts their bit offsets', () => {
  const layout = buildDeviceLayout([{
    usagePage: 0x01,
    usage: 0x08,
    inputReports: [{
      reportId: 1,
      items: [
        { isConstant: true, reportSize: 8, reportCount: 1 },
        axisItem([X, Y, Z]),
      ],
    }],
  }]);
  assert.ok(layout);
  const fields = layout.reports.get(1);
  assert.ok(fields);
  assert.deepEqual(fields.map((f) => f.bitOffset), [8, 24, 40]);
  // 1 padding byte, then tx = 350 (0x5e 0x01 LE).
  const state = parseReportWithLayout(fields, bytes([0xff, 0x5e, 0x01, 0, 0, 0, 0]), zeroSixDof());
  assert.equal(state.tx, 350);
});

test('usage ranges (X..RZ via usageMinimum/Maximum) map like listed usages', () => {
  const layout = buildDeviceLayout([{
    usagePage: 0x01,
    usage: 0x08,
    inputReports: [{
      reportId: 1,
      items: [{
        isRange: true,
        usageMinimum: X,
        usageMaximum: RZ,
        reportSize: 16,
        reportCount: 6,
        logicalMinimum: -350,
        logicalMaximum: 350,
      }],
    }],
  }]);
  assert.ok(layout);
  assert.equal(layoutAxisCount(layout), 6);
  const fields = layout.reports.get(1);
  assert.ok(fields);
  const state = parseReportWithLayout(fields, i16([1, 2, 3, 4, 5, 6]), zeroSixDof());
  assert.deepEqual(state, { tx: 1, ty: 2, tz: 3, rx: 4, ry: 5, rz: 6 });
});

test('unaligned 10-bit fields extract and sign-extend correctly', () => {
  const field: AxisField = { axis: 'tx', bitOffset: 6, bitSize: 10, logicalMinimum: -350, logicalMaximum: 350 };
  // Value -2 in 10 bits = 0b1111111110, placed at bit offset 6.
  const buffer = new Uint8Array(2);
  const value = 0b1111111110;
  for (let i = 0; i < 10; i++) {
    if ((value >> i) & 1) buffer[(6 + i) >> 3] |= 1 << ((6 + i) & 7);
  }
  assert.equal(readAxisField(new DataView(buffer.buffer), field), -2);
});

test('nested collections are walked for axes', () => {
  const layout = buildDeviceLayout([{
    usagePage: 0x01,
    usage: 0x08,
    children: [{
      usagePage: 0x01,
      usage: 0x01,
      inputReports: [{ reportId: 1, items: [axisItem([X, Y, Z])] }],
    }],
  }]);
  assert.ok(layout);
  assert.equal(layoutAxisCount(layout), 3);
});

test('descriptors without enough axes fall back to null (legacy parser)', () => {
  assert.equal(buildDeviceLayout(undefined), null);
  assert.equal(buildDeviceLayout([]), null);
  assert.equal(buildDeviceLayout([{ usagePage: 0x01, usage: 0x08 }]), null);
  // Two axes only: not trustworthy for 6DoF, prefer the legacy layout.
  assert.equal(
    buildDeviceLayout([{
      usagePage: 0x01,
      usage: 0x08,
      inputReports: [{ reportId: 1, items: [axisItem([X, Y])] }],
    }]),
    null,
  );
});

test('malformed items (zero sizes, missing usages) are skipped, never throw', () => {
  const layout = buildDeviceLayout([{
    usagePage: 0x01,
    usage: 0x08,
    inputReports: [{
      reportId: 1,
      items: [
        { reportSize: 0, reportCount: 3, usages: [X] },
        { reportSize: 16, reportCount: 0, usages: [X] },
        {},
        axisItem([X, Y, Z]),
      ],
    }],
  }]);
  assert.ok(layout);
  const fields = layout.reports.get(1);
  assert.ok(fields);
  // The malformed items contribute no bits, so axes start at offset 0.
  assert.deepEqual(fields.map((f) => f.bitOffset), [0, 16, 32]);
});

test('truncated report keeps previous values for unreadable axes', () => {
  const layout = buildDeviceLayout(splitCollections());
  assert.ok(layout);
  const fields = layout.reports.get(1);
  assert.ok(fields);
  const prev = { ...zeroSixDof(), tx: 100, ty: 200, tz: 300 };
  // Only 3 bytes: tx readable, ty/tz truncated.
  const state = parseReportWithLayout(fields, bytes([0x0a, 0x00, 0x7f]), prev);
  assert.equal(state.tx, 10);
  assert.equal(state.ty, 200);
  assert.equal(state.tz, 300);
});

test('unsigned logical ranges are centred on their midpoint (0..700 rests at 350)', () => {
  // Some descriptors declare 0..700 with a 350 midpoint instead of -350..350.
  // Scaling around zero would turn the resting value into constant drift.
  const field: AxisField = { axis: 'tx', bitOffset: 0, bitSize: 16, logicalMinimum: 0, logicalMaximum: 700 };
  const at = (value: number) => {
    const view = new DataView(new ArrayBuffer(2));
    view.setUint16(0, value, true);
    return readAxisField(view, field);
  };
  assert.equal(at(350), 0); // resting midpoint is neutral
  assert.equal(at(0), -AXIS_FULL_SCALE);
  assert.equal(at(700), AXIS_FULL_SCALE);
  assert.equal(at(525), AXIS_FULL_SCALE / 2);
  // Out-of-range garbage (would be negative as int16) clamps, stays positive.
  assert.equal(at(65000), AXIS_FULL_SCALE);
});

test('symmetric signed ranges are unaffected by midpoint centring', () => {
  const field: AxisField = { axis: 'ty', bitOffset: 0, bitSize: 16, logicalMinimum: -350, logicalMaximum: 350 };
  const at = (value: number) => {
    const view = new DataView(new ArrayBuffer(2));
    view.setInt16(0, value, true);
    return readAxisField(view, field);
  };
  assert.equal(at(0), 0);
  assert.equal(at(175), 175);
  assert.equal(at(-350), -AXIS_FULL_SCALE);
});
