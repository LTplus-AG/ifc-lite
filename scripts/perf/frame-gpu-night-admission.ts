/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync, realpathSync } from 'node:fs';
import { readPinnedArtifact, sha256, type NightProfile } from './frame-gpu-night-profile.js';

interface Controller { name: string; device: string; driver: string }
export interface NativeOutputProfile {
  monitor: string; left: number; top: number; width: number; height: number;
  frequencyHz: number; bitsPerPixel: number; orientation: number; dpi: number;
  controllers: Controller[];
}
export interface ViewportProfile {
  cssWidth: number; cssHeight: number; pixelWidth: number; pixelHeight: number; dpr: number;
}
export interface HostProfile {
  version: 1;
  browser: { executable: string; sha256: string; version: string; executableWin: string };
  adapter: { vendor: string; architecture: string };
  viewport: ViewportProfile;
  output: NativeOutputProfile;
  minimumUserIdleSeconds: number;
}

const record = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`missing ${label}`);
  return value as Record<string, unknown>;
};
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`missing ${label}`);
  return value;
}
function positive(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`invalid ${label}`);
  return value;
}
function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`invalid ${label}`);
  return value;
}

export function decodeViewportProfile(value: unknown): ViewportProfile {
  const row = record(value, 'actual viewport');
  return {
    cssWidth: positive(row.cssWidth, 'CSS width'), cssHeight: positive(row.cssHeight, 'CSS height'),
    pixelWidth: positive(integer(row.pixelWidth, 'pixel width'), 'pixel width'),
    pixelHeight: positive(integer(row.pixelHeight, 'pixel height'), 'pixel height'), dpr: positive(row.dpr, 'actual DPR'),
  };
}

export function decodeNativeOutput(value: unknown): NativeOutputProfile {
  const row = record(value, 'native output');
  if (!Array.isArray(row.controllers) || !row.controllers.length) throw new Error('native GPU controller inventory unavailable');
  const controllers = row.controllers.map((value: unknown) => {
    const controller = record(value, 'controller');
    return { name: text(controller.name, 'controller name'), device: text(controller.device, 'controller device'), driver: text(controller.driver, 'driver version') };
  }).sort((a, b) => a.device.localeCompare(b.device));
  if (new Set(controllers.map((row) => row.device)).size !== controllers.length) throw new Error('duplicate controller identity');
  const orientation = integer(row.orientation, 'display orientation');
  if (orientation < 0 || orientation > 3) throw new Error('invalid display orientation');
  const frequencyHz = positive(integer(row.frequencyHz, 'display refresh'), 'display refresh');
  if (frequencyHz <= 1) throw new Error('display reports default/unknown refresh');
  return {
    monitor: text(row.monitor, 'monitor device'), left: integer(row.left, 'monitor left'), top: integer(row.top, 'monitor top'),
    width: positive(integer(row.width, 'display width'), 'display width'), height: positive(integer(row.height, 'display height'), 'display height'),
    frequencyHz, bitsPerPixel: positive(integer(row.bitsPerPixel, 'display bits'), 'display bits'), orientation,
    dpi: positive(integer(row.dpi, 'window DPI'), 'window DPI'), controllers,
  };
}

export function decodeHostProfile(value: unknown): HostProfile {
  const row = record(value, 'immutable host profile');
  if (row.version !== 1) throw new Error('invalid host profile version');
  const browser = record(row.browser, 'browser profile'), adapter = record(row.adapter, 'adapter profile');
  const hash = text(browser.sha256, 'browser executable hash');
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('invalid browser executable hash');
  return {
    version: 1, browser: { executable: text(browser.executable, 'browser executable'), executableWin: text(browser.executableWin, 'Windows executable'),
      sha256: hash, version: text(browser.version, 'browser version') },
    adapter: { vendor: text(adapter.vendor, 'renderer adapter vendor'), architecture: text(adapter.architecture, 'renderer adapter architecture') },
    viewport: decodeViewportProfile(row.viewport), output: decodeNativeOutput(row.output),
    minimumUserIdleSeconds: positive(integer(row.minimumUserIdleSeconds, 'explicit user-idle minimum'), 'explicit user-idle minimum'),
  };
}

/** The hostProfile names a pinned artifact; an opaque label cannot authorize nightly admission. */
export function readHostProfile(checkout: string, profile: NightProfile): HostProfile {
  const artifact = profile.artifacts.find((row) => row.path === profile.hostProfile);
  if (!artifact) throw new Error('host profile must be a pinned artifact');
  const bytes = readPinnedArtifact(checkout, artifact);
  return decodeHostProfile(JSON.parse(bytes.toString('utf8')) as unknown);
}

export function requireBrowserExecutable(host: HostProfile, actualExecutable: string): void {
  if (realpathSync(actualExecutable) !== realpathSync(host.browser.executable)
    || sha256(readFileSync(actualExecutable)) !== host.browser.sha256) throw new Error('browser executable differs from pinned host profile');
}

export function requireHostMatch(host: HostProfile, actual: {
  browserVersion: string; adapter: unknown; viewport: unknown; output: NativeOutputProfile; executableWin: string;
}): void {
  if (actual.browserVersion !== host.browser.version || actual.executableWin.toLowerCase() !== host.browser.executableWin.toLowerCase()) {
    throw new Error('actual browser executable/version changed');
  }
  const adapter = record(actual.adapter, 'actual renderer adapter');
  if (text(adapter.vendor, 'actual adapter vendor') !== host.adapter.vendor
    || text(adapter.architecture, 'actual adapter architecture') !== host.adapter.architecture
    || /swiftshader|software|llvmpipe/i.test(`${adapter.vendor} ${adapter.architecture}`)) throw new Error('actual renderer adapter changed or is software');
  if (JSON.stringify(decodeViewportProfile(actual.viewport)) !== JSON.stringify(host.viewport)
    || JSON.stringify(decodeNativeOutput(actual.output)) !== JSON.stringify(host.output)) throw new Error('actual display/viewport/driver profile changed');
}
