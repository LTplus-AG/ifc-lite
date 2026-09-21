/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { EntityRef } from './types.js';

/** Convert an in-store federated entity reference into its stable key. */
export function entityRefToString(ref: EntityRef): string {
  return `${ref.modelId}:${ref.expressId}`;
}

/** Parse an untrusted state key without throwing on malformed input. */
export function stringToEntityRef(str: string): EntityRef {
  const colonIndex = str.indexOf(':');
  if (colonIndex === -1) return { modelId: '', expressId: -1 };
  const modelId = str.substring(0, colonIndex);
  const expressId = parseInt(str.substring(colonIndex + 1), 10);
  return Number.isNaN(expressId) ? { modelId, expressId: -1 } : { modelId, expressId };
}

export function entityRefEquals(a: EntityRef | null, b: EntityRef | null): boolean {
  return a === null || b === null ? a === b : a.modelId === b.modelId && a.expressId === b.expressId;
}
