/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Node handles: the model names a node it creates with `@name` instead of
 * inventing a UUID (`"specId": "@doors"`), and refers to it the same way in
 * later ops of the same run. The sandbox replaces every handle with a UUID
 * derived from the run id and the handle, so the mapping is stable across
 * tool calls and reproducible in a replayed run. Missing `opId`s are filled
 * the same way.
 *
 * Only id-typed positions are rewritten (keys ending in `Id`/`Ids`, `scope`
 * and the values of `constraintIds`), so a literal value such as `"@home"`
 * in a property value is never touched.
 */

import { deriveId, type Uuid } from '@ifc-lite/ids-authoring';

export const HANDLE_PATTERN = '^@[A-Za-z][A-Za-z0-9_-]{0,47}$';
const HANDLE = new RegExp(HANDLE_PATTERN);

export interface HandleTable {
  /** Handle → UUID, for every handle seen in the run. */
  readonly handles: ReadonlyMap<string, Uuid>;
  /** Resolve handles and fill missing op ids in a batch of untrusted ops. */
  resolve(ops: readonly unknown[]): unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIdKey(key: string): boolean {
  return key.endsWith('Id') || key.endsWith('Ids') || key === 'scope';
}

export function createHandleTable(runId: string): HandleTable {
  const handles = new Map<string, Uuid>();
  let opCounter = 0;
  const idFor = (value: unknown): unknown => {
    if (typeof value !== 'string' || !HANDLE.test(value)) return value;
    let id = handles.get(value);
    if (!id) {
      id = deriveId(`ids-agent|${runId}`, `handle|${value}`);
      handles.set(value, id);
    }
    return id;
  };
  const walk = (value: unknown, idPosition: boolean): unknown => {
    if (Array.isArray(value)) return value.map((item) => walk(item, idPosition));
    if (!isRecord(value)) return idPosition ? idFor(value) : value;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === 'constraintIds' && isRecord(child)) {
        out[key] = Object.fromEntries(Object.entries(child).map(([field, id]) => [field, idFor(id)]));
      } else {
        out[key] = walk(child, isIdKey(key));
      }
    }
    return out;
  };
  return {
    handles,
    resolve(ops) {
      return ops.map((op) => {
        const resolved = walk(op, false);
        if (isRecord(resolved) && resolved.opId === undefined) {
          resolved.opId = deriveId(`ids-agent|${runId}`, `op|${opCounter++}`);
        }
        return resolved;
      });
    },
  };
}
