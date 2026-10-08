/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readContentRows } from './content-database.js';
import { migrateContent, type ContentDefinition } from './content-migration.js';

/** Durable library reads share migration, tombstone and validation semantics. */
export async function readContentEntries<T extends { id: string }>(definition: ContentDefinition<T>): Promise<T[]> {
  await migrateContent(definition);
  return (await readContentRows(definition.kind)).flatMap(row => {
    if (row.deleted) return [];
    const entry = definition.decode(row.payload);
    if (!entry) throw new Error('Invalid saved user content; original preserved');
    return [entry];
  });
}
