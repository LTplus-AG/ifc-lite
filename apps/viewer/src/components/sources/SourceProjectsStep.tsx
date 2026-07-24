/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileSourceProvider, PluginContext, SourceProject } from '@ifc-lite/plugin-api';
import { usePagedList } from './usePagedList';
import { SourceEntityList, LoadMoreRow } from './SourceEntityList';
import { Input } from '@/components/ui/input';
import { Folder, Search } from 'lucide-react';

interface SourceProjectsStepProps {
  provider: FileSourceProvider;
  ctx: PluginContext;
  onError: (message: string) => void;
  onSelect: (project: SourceProject) => void;
}

/**
 * Paged project list. For providers declaring `projectsAreDiscoverableOnly`
 * the list may be incomplete by design (delegated Microsoft Graph cannot
 * enumerate "every site I can see"), so a search field is always shown and
 * the list is labelled as non-exhaustive.
 */
export function SourceProjectsStep({ provider, ctx, onError, onSelect }: SourceProjectsStepProps) {
  const discoverableOnly = provider.manifest.capabilities.projectsAreDiscoverableOnly === true;
  const [query, setQuery] = useState('');
  // The fetcher reads the query from a ref so submitting a new search only
  // needs a `start()`, not a rebuilt hook.
  const queryRef = useRef('');

  const paged = usePagedList<SourceProject>(
    useCallback(
      (cursor, signal) =>
        provider.listProjects(ctx, {
          cursor,
          signal,
          query: queryRef.current.trim() || undefined,
        }),
      [provider, ctx],
    ),
    onError,
  );

  // `start` is stable (its deps are the stable fetcher + onError), so this
  // runs once per provider/ctx.
  const { start } = paged;
  useEffect(() => {
    start();
  }, [start]);

  const submitSearch = useCallback(() => {
    queryRef.current = query;
    start();
  }, [query, start]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {discoverableOnly && (
        <div className="border-b px-3 py-2">
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              className="h-8 pl-7 text-sm"
              placeholder="Search projects…"
              aria-label="Search projects"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitSearch();
              }}
            />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            This provider cannot list every project — search to find more.
          </p>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        <SourceEntityList
          items={paged.items}
          loading={paged.loading}
          icon={Folder}
          emptyLabel={discoverableOnly ? 'No projects found — try a search' : 'No projects found'}
          onSelect={onSelect}
        />
        <LoadMoreRow
          hasMore={paged.hasMore}
          loading={paged.loadingMore}
          onLoadMore={paged.loadMore}
          label="Load more projects"
        />
      </div>
    </div>
  );
}
