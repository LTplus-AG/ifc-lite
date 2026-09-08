/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { SourceContainer } from '@ifc-lite/plugin-api';
import { SourceEntityList, LoadMoreRow } from './SourceEntityList';
import { FolderOpen } from 'lucide-react';

interface SourceFileAreasStepProps {
  fileAreas: readonly SourceContainer[];
  loading: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onSelect: (fileArea: SourceContainer) => void;
  onLoadMore: () => void;
}

/**
 * Paged list of a project's top-level containers ("file areas").
 *
 * Presentational only: the listing state lives in `SourceBrowser` so it
 * survives stepping into a file area and back out again, which must not
 * re-fetch.
 */
export function SourceFileAreasStep({
  fileAreas,
  loading,
  hasMore,
  loadingMore,
  onSelect,
  onLoadMore,
}: SourceFileAreasStepProps) {
  return (
    <div className="flex-1 overflow-y-auto">
      <SourceEntityList
        items={fileAreas}
        loading={loading}
        icon={FolderOpen}
        emptyLabel="No file areas found"
        onSelect={onSelect}
      />
      <LoadMoreRow hasMore={hasMore} loading={loadingMore} onLoadMore={onLoadMore} label="Load more" />
    </div>
  );
}
