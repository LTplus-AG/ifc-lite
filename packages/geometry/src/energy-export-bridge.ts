/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * HBJSON / DFJSON `IfcAPI` call sites for `IfcLiteBridge`, split out to keep
 * `ifc-lite-bridge.ts` under the module-size ratchet (`scripts/check-module-size.mjs`).
 * Pure functions over an already-initialized `IfcAPI` handle — no bridge state, so
 * `IfcLiteBridge` just forwards into these through its existing `runExport` error
 * wrapper (init guard + structured error logging + fatal-wasm-error marking stay
 * there, not duplicated here).
 */

import type { IfcAPI } from '@ifc-lite/wasm';
import type { HbjsonStats } from './hbjson-stats.js';

/**
 * Export the `IfcSpace` volumes in `content` as a Honeybee HBJSON string
 * (Ladybug Tools energy/daylight model). Rooms are built analytically from
 * extruded-area profiles (watertight by construction).
 */
export function callExportHbjson(api: IfcAPI, content: Uint8Array, name: string): Uint8Array {
  return api.exportHbjson(content, name);
}

/**
 * Like {@link callExportHbjson}, but also returns the export's coverage stats
 * (`HbjsonStats`: spaces seen, rooms emitted, spaces skipped as degenerate, plus
 * apertures / doors / shades / constructions / interior adjacencies) so a caller
 * can tell whether a "successful" export silently dropped `IfcSpace` volumes.
 * Runs the export once — `content` and `stats` come from the same wasm call.
 */
export function callExportHbjsonWithStats(
  api: IfcAPI,
  content: Uint8Array,
  name: string,
): { content: Uint8Array; stats: HbjsonStats } {
  return api.exportHbjsonWithStats(content, name) as { content: Uint8Array; stats: HbjsonStats };
}

/**
 * Export the `IfcSpace` volumes in `content` as a Dragonfly DFJSON string
 * (Ladybug Tools energy model). Each space becomes an extruded `Room2D`
 * (floor polygon + height) grouped into stories — the simpler target for
 * mostly-vertical-wall models.
 */
export function callExportDfjson(api: IfcAPI, content: Uint8Array, name: string): string {
  return api.exportDfjson(content, name);
}
