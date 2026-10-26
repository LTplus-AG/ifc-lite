/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { diffBuildDataFingerprint, diffBuildComponentFingerprints, diffNormalizeValue, diffStableHash } from '@ifc-lite/wasm/diff';
import { diffModelConstructor } from './wasm-runtime.js';
import type { ComponentKey, DataFingerprintInput, PropertyEntryInput } from './fingerprint.js';

/** Hash original JavaScript UTF-16 units without scalar-string conversion. */
export function stableHash(value: string): string {
  diffModelConstructor();
  const units = new Uint16Array(value.length);
  for (let i = 0; i < value.length; i++) units[i] = value.charCodeAt(i);
  return diffStableHash(units);
}

/** Rust owns normalization; host exception reporting and String conversion
 * preserve the unknown-value contract, including throwing fallback coercions. */
export function normalizeValue(value: unknown): string | number | boolean | null {
  diffModelConstructor();
  try {
    return diffNormalizeValue(value);
  } catch (error) {
    console.warn('[diff] normalizeValue: non-serializable value, using String() fallback:', error);
    return String(value);
  }
}

// Read only adapter fields consumed by the engine. Property values are unknown
// host values: normalization runs in Rust before the scalar DTO is transported.
function projectInput(input: DataFingerprintInput, components: boolean): DataFingerprintInput {
  const attributes = () => ({ ifcType: input.ifcType, name: input.name, description: input.description,
    objectType: input.objectType, predefinedType: input.predefinedType, tag: input.tag });
  const entries = (values: PropertyEntryInput[]) => values.map(entry => ({ name: entry.name, value: normalizeValue(entry.value) }));
  const collections = () => {
    const propertySets = (input.propertySets ?? []).map(set => ({ name: set.name, properties: entries(set.properties) }));
    // The oracle's component for-of visits holes AFTER map has observed all
    // present records, and BEFORE it reads the next collection (#8042).
    // These are fresh plain DTOs: reading name only recreates the host error.
    if (components) for (const set of propertySets) void set.name;
    const quantitySets = (input.quantitySets ?? []).map(set => ({ name: set.name, quantities: entries(set.quantities) }));
    if (components) for (const set of quantitySets) void set.name;
    return {
      propertySets, quantitySets,
      typeAssignments: (input.typeAssignments ?? []).map(type => ({ name: type.name, type: type.type })),
      materials: (input.materials ?? []).filter(value => typeof value === 'string' && value.length > 0),
      classifications: (input.classifications ?? []).filter(value => typeof value === 'string' && value.length > 0),
    };
  };
  // The original component path reads attributes before collection values;
  // the full fingerprint path reads collection values first.
  return components ? { ...attributes(), ...collections() } : { ...collections(), ...attributes() };
}

export function buildDataFingerprint(input: DataFingerprintInput): string {
  diffModelConstructor();
  return diffBuildDataFingerprint(projectInput(input, false));
}

export function buildComponentFingerprints(input: DataFingerprintInput): Record<ComponentKey, string> {
  diffModelConstructor();
  return diffBuildComponentFingerprints(projectInput(input, true)) as Record<ComponentKey, string>;
}
