/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { AppearanceScope } from './draft-types';
import { ownAppearanceQuery } from './query-definition';
/** Same scope variants the native picker offers; Rules validation stays canonical. */
export function decodeAppearanceScope(value: unknown): AppearanceScope {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('kind' in value)) throw new Error('Invalid native appearance scope.');
  const keys = Object.keys(value);
  switch (value.kind) {
    case 'model': case 'selection': if (keys.length === 1) return { kind: value.kind }; break;
    case 'class': if (keys.length === 2 && 'ifcClass' in value && typeof value.ifcClass === 'string' && /^Ifc[A-Za-z0-9]+$/.test(value.ifcClass)) return { kind: 'class', ifcClass: value.ifcClass }; break;
    case 'type': if (keys.length === 2 && 'typeId' in value && typeof value.typeId === 'number' && Number.isSafeInteger(value.typeId) && value.typeId > 0) return { kind: 'type', typeId: value.typeId }; break;
    case 'filter': if (keys.length === 2 && 'query' in value) return { kind: 'filter', query: ownAppearanceQuery(value.query) }; break;
  }
  throw new Error('Invalid native appearance scope fields.');
}
