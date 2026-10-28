/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { diffKeyAliasesFromSidecarValue, diffSidecarValueMismatches } from '@ifc-lite/wasm/diff';
import { diffModelConstructor } from './wasm-runtime.js';
import { createSidecar, parseSidecar, serializeSidecar, validateSidecar } from './wasm-sidecar.js';
import type { IdentityMapSidecar, IdentityMapSidecarInit, ModelIdentity } from './identity-sidecar.js';
export type { IdentityMapSidecar, IdentityMapSidecarInit, ModelIdentity } from './identity-sidecar.js';
export const IDENTITY_MAP_SIDECAR_FORMAT = 'ifc-lite/identity-map';
export const IDENTITY_MAP_SIDECAR_VERSION = 1;
export const IDENTITY_MAP_SIDECAR_KEYED_VERSION = 2;

export function createIdentityMapSidecar(init: IdentityMapSidecarInit): IdentityMapSidecar {
  return createSidecar(init, false) as IdentityMapSidecar;
}
export function serializeIdentityMapSidecar(sidecar: IdentityMapSidecar): string {
  return serializeSidecar(sidecar);
}
export function parseIdentityMapSidecar(text: string): IdentityMapSidecar {
  return parseSidecar(text, false) as IdentityMapSidecar;
}
export function validateIdentityMapSidecar(value: unknown): string[] {
  return validateSidecar(value, false);
}
export function identityMapSidecarMismatches(sidecar: IdentityMapSidecar, models: { base: ModelIdentity; head: ModelIdentity; keyProperty?: string }): string[] {
  diffModelConstructor();
  return diffSidecarValueMismatches(sidecar, models, false);
}
export function keyAliasesFromSidecar(sidecar: IdentityMapSidecar): Map<string, string> {
  diffModelConstructor();
  return new Map(diffKeyAliasesFromSidecarValue(sidecar) as [string, string][]);
}
