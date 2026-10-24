/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { diffSidecarValueMismatches } from '@ifc-lite/wasm/diff';
import { diffModelConstructor } from './wasm-runtime.js';
import { createSidecar, parseSidecar, serializeSidecar, validateSidecar } from './wasm-sidecar.js';
import type { LineageSidecar, LineageSidecarInit } from './lineage-sidecar.js';
import type { ModelIdentity } from './sidecar-common.js';
export type { LineageSidecar, LineageSidecarInit } from './lineage-sidecar.js';
export const LINEAGE_SIDECAR_FORMAT = 'ifc-lite/lineage';
export const LINEAGE_SIDECAR_VERSION = 1;
export const LINEAGE_SIDECAR_KEYED_VERSION = 2;

export function createLineageSidecar(init: LineageSidecarInit): LineageSidecar {
  return createSidecar(init, true) as LineageSidecar;
}
export function serializeLineageSidecar(sidecar: LineageSidecar): string {
  return serializeSidecar(sidecar);
}
export function parseLineageSidecar(text: string): LineageSidecar {
  return parseSidecar(text, true) as LineageSidecar;
}
export function validateLineageSidecar(value: unknown): string[] {
  return validateSidecar(value, true);
}
export function lineageSidecarMismatches(sidecar: LineageSidecar, models: { base: ModelIdentity; head: ModelIdentity; keyProperty?: string }): string[] {
  diffModelConstructor();
  return diffSidecarValueMismatches(sidecar, models, true);
}
