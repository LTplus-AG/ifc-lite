/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// internal: in-repo consumers only; no semver guarantee
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
  const Model = diffModelConstructor();
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
  const decode = (rows: typeof projected) => unpackDocument(Model.buildFingerprintBatch(packDocument(rows))) as {
    dataHash: string; components: Record<ComponentKey, string>;
  }[];
  // Snapshot every adapter before entering native computation. Bounded dense
  // chunks keep the transport dictionary and native input graph out of the
  // full-model allocation/GC regime (#8042), without retaining a hidden cache.
  // Sparse inputs keep whole-document validation and host length-check order.
  const sparse = projected.findIndex(row => row === undefined
    || row.propertySets.holes > 0 || row.quantitySets.holes > 0 || row.typeAssignments.holes > 0
    || row.propertySets.present.some(set => set.members.holes > 0)
    || row.quantitySets.present.some(set => set.members.holes > 0)) !== -1;
  if (projected.length <= 512 || sparse) return decode(projected);
  const results: ReturnType<typeof decode> = [];
  for (let start = 0; start < projected.length; start += 512) {
    results.push(...decode(projected.slice(start, start + 512)));
  }
  return results;
}

export { DiffModelHandle, prepareDiffModel } from './prepared-model.js';
export type { DiffModelHandle as PreparedDiffModel } from './prepared-model.js';
