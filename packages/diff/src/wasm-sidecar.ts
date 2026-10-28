/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { diffCreateSidecarValue, diffValidateSidecarValue, diffSerializeSidecarValue } from '@ifc-lite/wasm/diff';
import { diffModelConstructor } from './wasm-runtime.js';

export function validateSidecar(value: unknown, lineage: boolean): string[] {
  diffModelConstructor();
  return diffValidateSidecarValue(value, lineage);
}

export function createSidecar(value: unknown, lineage: boolean): unknown {
  diffModelConstructor();
  return diffCreateSidecarValue(value, lineage);
}

/** Host JSON.parse owns syntax, coercion, depth and lone UTF-16 units. Rust
 * observes the resulting value without traversing or serializing ignored extras. */
export function parseSidecar(text: string, lineage: boolean): unknown {
  diffModelConstructor();
  const label = lineage ? 'lineage' : 'identity-map';
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid ${label} sidecar: not JSON (${(error as Error).message})`);
  }
  const errors = validateSidecar(value, lineage);
  if (errors.length > 0) throw new Error(`Invalid ${label} sidecar: ${errors.join('; ')}`);
  return value;
}

/** Serialization's original contract IS host JSON.stringify, including
 * toJSON, unsupported values, property order, cycles and native exceptions. */
export function serializeSidecar(value: unknown): string {
  diffModelConstructor();
  return diffSerializeSidecarValue(value);
}
