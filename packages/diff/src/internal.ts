/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// internal: in-repo consumers only; no semver guarantee
import { diffBuildPackedFingerprints } from '@ifc-lite/wasm/diff';
import type { DataFingerprintInput, ComponentKey } from './fingerprint.js';
import { projectInput } from './wasm-fingerprint.js';
import { packDocument, unpackDocument } from './wasm-binary.js';
import { diffModelConstructor } from './wasm-runtime.js';

/** Explicit snapshot batch. Each input is projected once, in component order.
 * No handles or adapter objects survive the call. Call again after mutations.
 * Consumers supply their freshly built adapter DTOs, before publishing them.
 */
export function buildFingerprintBatch(inputs: readonly DataFingerprintInput[]): {
  dataHash: string; components: Record<ComponentKey, string>;
}[] {
  diffModelConstructor();
  const slots = <T, U>(values: T[], project: (value: T) => U) => {
    const present: U[] = [];
    let holes = 0;
    for (let i = 0; i < values.length; i++) {
      if (i in values) present.push(project(values[i])); else holes++;
    }
    return { present, holes };
  };
  const projected = inputs.map(input => {
    const dto = projectInput(input, true);
    return {
      ...dto,
      propertySets: slots(dto.propertySets ?? [], set => ({ name: set.name, members: slots(set.properties, value => value) })),
      quantitySets: slots(dto.quantitySets ?? [], set => ({ name: set.name, members: slots(set.quantities, value => value) })),
      typeAssignments: slots(dto.typeAssignments ?? [], value => value),
    };
  });
  return unpackDocument(diffBuildPackedFingerprints(packDocument(projected))) as {
    dataHash: string; components: Record<ComponentKey, string>;
  }[];
}
