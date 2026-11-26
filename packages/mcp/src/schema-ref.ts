/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Local `$ref` resolution for `validate.ts`. */

import type { JsonSchema } from './protocol/index.js';

/** A defect in the schema itself (bad `$ref`, bad `pattern`), not in the caller's input. */
export class SchemaError extends Error {}

/** The schema a local `$ref` (`#/a/b`) points at, which may be a boolean schema. */
export function resolveRef(ref: string, root: JsonSchema): JsonSchema | boolean {
  // Local JSON Pointers only; an anchor (`#Foo`) or a remote URI is not resolved.
  if (ref !== '#' && !ref.startsWith('#/')) throw new SchemaError(`Unsupported $ref '${ref}'`);
  let target: unknown = root;
  // `#` is the root; every segment after it is a key, including an empty one (RFC 6901).
  for (const raw of ref === '#' ? [] : ref.slice(1).split('/').slice(1)) {
    const key = decodePointerSegment(raw, ref);
    target = target !== null && typeof target === 'object' ? own(target as Record<string, unknown>, key) : undefined;
  }
  if (typeof target === 'boolean' || (target !== null && typeof target === 'object' && !Array.isArray(target))) {
    return target as JsonSchema | boolean;
  }
  throw new SchemaError(`Unresolvable $ref '${ref}'`);
}

function decodePointerSegment(raw: string, ref: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch (err) {
    if (err instanceof URIError) throw new SchemaError(`Unresolvable $ref '${ref}': bad percent-escape`);
    throw err;
  }
  return decoded.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** An own property only: a key named `constructor` must not read Object.prototype's. */
export function own(obj: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}
