/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { DocumentBlock } from './types';

/** Move authored blocks as a stable group (#8066). Null means the document end;
 * stale or selected destinations are no-ops, never accidental moves to the end. */
export function reorderDocumentBlocks(blocks: DocumentBlock[], ids: ReadonlySet<string>, beforeId: string | null): DocumentBlock[] {
  if (beforeId !== null && (ids.has(beforeId) || !blocks.some(block => block.id === beforeId))) return blocks;
  const moving = blocks.filter(block => ids.has(block.id));
  if (!moving.length) return blocks;
  const remaining = blocks.filter(block => !ids.has(block.id));
  const index = beforeId === null ? remaining.length : remaining.findIndex(block => block.id === beforeId);
  const next = [...remaining.slice(0, index), ...moving, ...remaining.slice(index)];
  return next.every((block, i) => block === blocks[i]) ? blocks : next;
}
