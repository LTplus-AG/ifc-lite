/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { assistantContent } from '../assistant/persistence.js';
import { clashGroupsContent } from '../clash/group-workspace.js';
import { bcfDraftsContent } from '../bcf-drafts/draft-library.js';
import { bcfOutboxContent } from '../bcf-publication/outbox-store.js';
import { modelChangeContent } from '../actions/receipts.js';
import { clashGroupApplicationContent } from '../clash/group-applications.js';
import { reviewWorkspacesContent } from '../review/workspace.js';
import { comparisonContent } from '../compare/savedComparisonPersistence.js';
import { documentContent } from '../document/persistence.js';
import { validationContent } from '../validation/reports/persistence.js';
import type { ContentDefinition } from './content-migration.js';
import { CONTENT_KINDS, type ContentKind } from './content-kinds.js';

/** Native codecs retain their concrete types; import/reference policies remain native. */
export const CONTENT_DEFINITIONS = {
  validation: validationContent,
  comparison: comparisonContent,
  document: documentContent,
  assistant: assistantContent,
  clashGroups: clashGroupsContent,
  bcfDrafts: bcfDraftsContent,
  bcfOutbox: bcfOutboxContent,
  modelChanges: modelChangeContent,
  clashGroupApplications: clashGroupApplicationContent,
  reviewWorkspaces: reviewWorkspacesContent,
} satisfies Record<ContentKind, Pick<ContentDefinition<{ id: string }>, 'kind' | 'legacyKey' | 'decode'>>;

export function contentKindForLegacyKey(key: string): ContentKind | undefined {
  return CONTENT_KINDS.find(kind => CONTENT_DEFINITIONS[kind].legacyKey === key);
}
