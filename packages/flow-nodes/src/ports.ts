/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Port types shared by the standard nodes; re-exported by `host.ts`. */

export const ENTITY_ITEM = { kind: 'entity', access: 'item' } as const;
export const ENTITY_LIST = { kind: 'entity', access: 'list' } as const;
export const ENTITY_GROUP = { kind: 'entity', access: 'group' } as const;
export const SCALAR_ITEM = { kind: 'scalar', access: 'item' } as const;
export const SCALAR_LIST = { kind: 'scalar', access: 'list' } as const;
export const TABLE_ITEM = { kind: 'table', access: 'item' } as const;
export const ANY_ITEM = { kind: 'any', access: 'item' } as const;
export const ANY_LIST = { kind: 'any', access: 'list' } as const;
export const ANY_GROUP = { kind: 'any', access: 'group' } as const;
