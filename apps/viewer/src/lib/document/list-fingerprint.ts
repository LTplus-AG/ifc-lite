/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ListDefinition } from '@ifc-lite/lists';

/** What a run is keyed by: the list's content, minus what cannot change its rows. */
export function listFingerprint(list: ListDefinition): string {
  const { id: _id, name: _name, description: _description, createdAt: _c, updatedAt: _u, ...content } = list;
  void _id; void _name; void _description; void _c; void _u;
  return JSON.stringify(content);
}
