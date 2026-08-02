/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Version of the host/provider *contract*, deliberately independent of this
 * package's npm version — the npm version moves whenever anything ships,
 * whereas this moves only when the interface changes.
 *
 * A provider declares the range it needs in `manifest.api`; a host declares
 * the version it implements by exporting this constant. They are compared with
 * `satisfiesCaretRange` at registration.
 *
 * Bump the major here for any breaking change to `FileSourceProvider`,
 * `PluginContext` or `PluginManifest`, and the minor for additive ones. Every
 * shipped provider's manifest is asserted against this value by
 * `test/conformance.test.ts`, so a mismatch fails CI rather than the browser.
 */
export const PLUGIN_API_VERSION = '2.0.0';

/**
 * Minimal `^x.y.z` caret-range check: same major, and host >= required.
 * Not a general semver implementation, and intentionally so — manifests use
 * exactly one range shape, and a real semver dependency would break this
 * package's dependency-free guarantee.
 *
 * Lives here rather than in the host so that host and provider can never
 * disagree about what a range means.
 */
export function satisfiesCaretRange(hostVersion: string, requiredRange: string): boolean {
  const required = /^\^?(\d+)\.(\d+)\.(\d+)$/.exec(requiredRange);
  const host = /^(\d+)\.(\d+)\.(\d+)$/.exec(hostVersion);
  if (!required || !host) return false;

  const [reqMajor, reqMinor, reqPatch] = required.slice(1).map(Number);
  const [hostMajor, hostMinor, hostPatch] = host.slice(1).map(Number);

  if (hostMajor !== reqMajor) return false;
  if (hostMinor !== reqMinor) return hostMinor > reqMinor;
  return hostPatch >= reqPatch;
}

/**
 * Case-insensitive glob match over a file name, supporting `*` and `?`.
 * Regex metacharacters in the pattern are escaped before wildcards are
 * expanded, so `plan(1).ifc` and `a+b.ifc` behave as literals.
 *
 * Shared rather than reimplemented per provider: name filtering is part of the
 * `FileFilter` contract, so every provider must agree on what `*.ifc` means.
 */
export function matchesGlob(name: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const expanded = escaped.replace(/\\\*/g, '.*').replace(/\\\?/g, '.');
  return new RegExp(`^${expanded}$`, 'i').test(name);
}
