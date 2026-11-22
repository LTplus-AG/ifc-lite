/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { create } from 'zustand';
import { createContentLibrary, initialContentStatus, type ContentStatus } from '../storage/content-library.js';
import type { ContentDefinition } from '../storage/content-migration.js';
import { decodeIdsStudioDraft, type IdsStudioDraft } from './draft-codec.js';

export const idsStudioDraftsContent: ContentDefinition<IdsStudioDraft> = {
  kind: 'idsStudioDrafts', legacyKey: 'ifc-lite-ids-studio-drafts', decode: decodeIdsStudioDraft,
};

export const useIdsStudioDraftLibrary = create<{ entries: IdsStudioDraft[]; status: ContentStatus }>(() => ({
  entries: [], status: initialContentStatus(),
}));

export const idsStudioDraftLibrary = createContentLibrary(idsStudioDraftsContent,
  () => useIdsStudioDraftLibrary.getState().entries,
  (entries, status) => useIdsStudioDraftLibrary.setState({ entries, status }));
