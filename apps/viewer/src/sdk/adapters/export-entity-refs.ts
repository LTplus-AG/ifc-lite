/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { EntityRef } from '@ifc-lite/sdk';

/**
 * Validate that a value is an array of EntityRef objects.
 */
export function isEntityRefArray(v: unknown): v is EntityRef[] {
  if (!Array.isArray(v)) return false;
  if (v.length === 0) return true;
  const first = v[0] as Record<string, unknown>;
  // Accept both raw EntityRef and entity proxy objects with .ref
  if ('modelId' in first && 'expressId' in first) {
    return typeof first.modelId === 'string' && typeof first.expressId === 'number';
  }
  if ('ref' in first && first.ref !== null && typeof first.ref === 'object') {
    const ref = first.ref as Record<string, unknown>;
    return typeof ref.modelId === 'string' && typeof ref.expressId === 'number';
  }
  return false;
}

/**
 * Normalize entity refs — entities from the sandbox may be EntityData
 * objects with a .ref property, or raw EntityRef { modelId, expressId }.
 */
export function normalizeRefs(raw: unknown[]): EntityRef[] {
  return raw.map((item) => {
    const r = item as Record<string, unknown>;
    if (r.ref && typeof r.ref === 'object') {
      return r.ref as EntityRef;
    }
    return { modelId: r.modelId as string, expressId: r.expressId as number };
  });
}
