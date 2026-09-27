/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { migrateLegacyListDefinition } from '@ifc-lite/lists';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Upgrade embedded List copies, including current-version documents saved before #5894. */
export function migrateDocumentListBlocks(blocks: unknown): unknown {
  if (!Array.isArray(blocks)) return blocks;
  return blocks.map((block: unknown) => {
    if (!isRecord(block) || block.kind !== 'table' || !isRecord(block.source)
      || block.source.kind !== 'list' || !isRecord(block.source.list)) return block;
    const list = block.source.list;
    if (!Array.isArray(list.groups) && !Array.isArray(list.conditions)) return block;
    try {
      return { ...block, source: { ...block.source, list: migrateLegacyListDefinition(list) } };
    } catch (error) {
      // Validation rejects this document; another saved document can still load.
      console.warn('[Documents] Saved table list could not be migrated', error);
      return block;
    }
  });
}
