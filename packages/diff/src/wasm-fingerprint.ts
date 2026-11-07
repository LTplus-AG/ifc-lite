/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { diffBuildDataFingerprint, diffBuildComponentFingerprints, diffCheckFingerprintCollections, diffNormalizeValue, diffStableHash } from '@ifc-lite/wasm/diff';
import { diffModelConstructor } from './wasm-runtime.js';
import type { ComponentKey, DataFingerprintInput, PropertyEntryInput, PropertySetInput, QuantitySetInput,
  TypeAssignmentInput } from './fingerprint.js';

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

// Primitive tokens need no host callback. Rust normalizes nonfinite numbers
// after decoding; composite values retain live host traversal and exceptions.
function projectValue(value: unknown): unknown {
  return value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? value : normalizeValue(value);
}

// Read only adapter fields consumed by the engine. Property values are unknown
// host values: normalization runs in Rust before the scalar DTO is transported.
export function projectInput(input: DataFingerprintInput, components: boolean): DataFingerprintInput {
  const attributes = () => ({ ifcType: input.ifcType, name: input.name, description: input.description,
    objectType: input.objectType, predefinedType: input.predefinedType, tag: input.tag });
  // map calls back only for present slots, so fewer calls than the fresh
  // result's length means a collection or member array has holes, with no
  // extra adapter read; that one length Get is where the oracle's sort reads
  // it. A result without a numeric length (e.g. a lazy iterator map) is never
  // offered: the check would consume it before the final decode (#8114).
  // Each map call keeps its expression, and so its host TypeError text.
  let sparse = false;
  const counted = <T, U>(one: (value: T) => U) => {
    let calls = 0;
    return {
      each: (value: T) => { calls++; return one(value); },
      settle: (result: U[]) => {
        const length: unknown = result.length;
        if (typeof length === 'number' && calls !== length) sparse = true;
        return result;
      },
    };
  };
  const entries = (values: PropertyEntryInput[]) => {
    const entry = counted((value: PropertyEntryInput) => ({ name: value.name, value: projectValue(value.value) }));
    return entry.settle(values.map(entry.each));
  };
  // The oracle sorts each collection (stableSerialize tiebreaks) and, for
  // components, hashes its sets before reading the next field, so an engine
  // string-length RangeError precedes later getters and the outer-hole
  // TypeError (#8114). Rust checks the fresh DTO; dense input skips the call.
  const check = (collection: Partial<DataFingerprintInput>, offered: boolean) => {
    if (sparse && offered) diffCheckFingerprintCollections(collection, components);
    sparse = false;
  };
  const collections = () => {
    const sets = counted((set: PropertySetInput) => ({ name: set.name, properties: entries(set.properties) }));
    const propertySets = sets.settle((input.propertySets ?? []).map(sets.each));
    check({ propertySets }, true);
    // The oracle's component for-of visits holes AFTER map has observed all
    // present records, and BEFORE it reads the next collection (#8042).
    // These are fresh plain DTOs: reading name only recreates the host error.
    if (components) for (const set of propertySets) void set.name;
    const quantities = counted((set: QuantitySetInput) => ({ name: set.name, quantities: entries(set.quantities) }));
    const quantitySets = quantities.settle((input.quantitySets ?? []).map(quantities.each));
    check({ quantitySets }, true);
    if (components) for (const set of quantitySets) void set.name;
    const types = counted((type: TypeAssignmentInput) => ({ name: type.name, type: type.type }));
    const typeAssignments = types.settle((input.typeAssignments ?? []).map(types.each));
    // Only the component type-assignment text precedes later reads.
    check({ typeAssignments }, components);
    return {
      propertySets, quantitySets, typeAssignments,
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
