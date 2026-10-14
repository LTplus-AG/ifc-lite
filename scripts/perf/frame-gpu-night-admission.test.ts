/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeHostProfile, decodeNativeOutput, readHostProfile, requireBrowserExecutable, requireHostMatch } from './frame-gpu-night-admission.js';
import { sha256, type NightProfile } from './frame-gpu-night-profile.js';

// Representative provider/schema invariants only, not native GPU/display proof.
const host = () => decodeHostProfile({
  version: 1, browser: { executable: '/test/chrome.exe', executableWin: 'C:\\Chrome\\chrome.exe', sha256: 'a'.repeat(64), version: '153.0.0.0' },
  adapter: { vendor: 'nvidia', architecture: 'turing' },
  viewport: { cssWidth: 1000, cssHeight: 720, pixelWidth: 1500, pixelHeight: 1080, dpr: 1.5 },
  output: { monitor: '\\\\.\\DISPLAY1', left: 0, top: 0, width: 2560, height: 1440, frequencyHz: 144, bitsPerPixel: 32, orientation: 0, dpi: 144,
    controllers: [{ name: 'GPU fixture', device: 'PCI\\fixture', driver: 'test-driver-1' }] }, minimumUserIdleSeconds: 300,
});

test('#6975 actual browser/adapter/display drift refuses a pinned host instead of mixing nights', () => {
  const expected = host();
  const actual = { browserVersion: expected.browser.version, executableWin: expected.browser.executableWin,
    adapter: expected.adapter, viewport: expected.viewport, output: expected.output };
  requireHostMatch(expected, actual);
  for (const changed of [
    { browserVersion: '154.0.0.0' }, { executableWin: 'C:\\Other\\chrome.exe' },
    { adapter: { vendor: 'intel', architecture: 'gen-12lp' } }, { adapter: null },
    { viewport: { ...expected.viewport, dpr: 2 } }, { viewport: { ...expected.viewport, pixelHeight: 720 } },
    { output: { ...expected.output, frequencyHz: 60 } },
    { output: { ...expected.output, controllers: [{ ...expected.output.controllers[0], driver: 'test-driver-2' }] } },
  ]) assert.throws(() => requireHostMatch(expected, { ...actual, ...changed }));
});

test('#6975 default/unknown refresh, missing driver and incomplete native output refuse admission', () => {
  const expected = host().output;
  for (const changed of [{ frequencyHz: 0 }, { frequencyHz: 1 }, { dpi: null }, { width: null }, { controllers: [] },
    { controllers: [{ ...expected.controllers[0], driver: null }] }, { controllers: [...expected.controllers, ...expected.controllers] }]) {
    assert.throws(() => decodeNativeOutput({ ...expected, ...changed }));
  }
});

test('#6975 executable drift checks actual file bytes and canonical path before startup', () => {
  const root = mkdtempSync(join(tmpdir(), '6975-browser-identity-'));
  try {
    const executable = join(root, 'chrome.exe'), other = join(root, 'other.exe');
    writeFileSync(executable, 'test-only executable bytes'); writeFileSync(other, readFileSync(executable));
    const expected = host(); expected.browser.executable = executable; expected.browser.sha256 = sha256(readFileSync(executable));
    requireBrowserExecutable(expected, executable);
    assert.throws(() => requireBrowserExecutable(expected, other), /differs/);
    writeFileSync(executable, 'updated executable');
    assert.throws(() => requireBrowserExecutable(expected, executable), /differs/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('#6975 host policy must be a pinned file inside the qualified checkout at point of use', () => {
  const root = mkdtempSync(join(tmpdir(), '6975-host-policy-'));
  const outside = mkdtempSync(join(tmpdir(), '6975-outside-policy-'));
  try {
    const bytes = Buffer.from(JSON.stringify(host()));
    writeFileSync(join(root, 'host.json'), bytes);
    writeFileSync(join(outside, 'host.json'), bytes);
    const profile: NightProfile = {
      version: 1, sourceHead: 'a'.repeat(40), rustTree: 'b'.repeat(40), dist: 'dist', fixture: 'model.ifc',
      qualificationReceipt: 'qualified.json', hostProfile: 'host.json', artifacts: [{ path: 'host.json', sha256: sha256(bytes) }],
    };
    assert.deepEqual(readHostProfile(root, profile), host());
    assert.throws(() => readHostProfile(root, { ...profile, artifacts: [] }), /pinned artifact/);
    const escape = `../${outside.split('/').at(-1)}/host.json`;
    assert.throws(() => readHostProfile(root, { ...profile, hostProfile: escape, artifacts: [{ path: escape, sha256: sha256(bytes) }] }), /escapes checkout/);
    writeFileSync(join(root, 'host.json'), JSON.stringify({ ...host(), minimumUserIdleSeconds: 1 }));
    assert.throws(() => readHostProfile(root, profile), /artifact changed/);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});
