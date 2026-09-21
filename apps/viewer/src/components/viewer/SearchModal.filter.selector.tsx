/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `SearchModalFilterSelector` — a thin adapter wiring the controlled
 * `SelectorTextEditor` (#5138 PR 5) to the search slice's `searchFilter`.
 * The parsing/feedback/readback behaviour itself lives in
 * `SelectorTextEditor.tsx`; this file only supplies the store subscription
 * and the border/padding chrome the Filter tab has always used.
 * `SearchModal.filter.selector.test.tsx` asserts on this component's
 * rendered output and passes unmodified (the lift invariant, #4091).
 */

import { useCallback } from 'react';
import { useViewerStore } from '@/store';
import type { FilterGroup } from '@ifc-lite/rules';
import { SelectorTextEditor, DOCS_URL } from './SelectorTextEditor';

export { DOCS_URL };

/**
 * The active model's IFC schema version, which is what decides how far a class
 * term expands. Both selector surfaces need it and neither needs the model
 * map, so the subscription lives here once.
 */
export function useActiveSchemaVersion(): string | undefined {
  return useViewerStore(
    (s) => (s.activeModelId ? s.models.get(s.activeModelId) : undefined)?.schemaVersion,
  );
}

export function SearchModalFilterSelector() {
  const limit = useViewerStore((s) => s.searchFilter.limit);
  const groups = useViewerStore((s) => s.searchFilter.groups);
  const setSearchFilter = useViewerStore((s) => s.setSearchFilter);
  const schemaVersion = useActiveSchemaVersion();

  const handleChange = useCallback(
    (nextGroups: FilterGroup[]) => setSearchFilter({ groups: nextGroups, limit }),
    [limit, setSearchFilter],
  );

  return (
    <div className="border-b border-zinc-200 px-4 pb-3 pt-4 dark:border-zinc-800">
      <SelectorTextEditor groups={groups} onChange={handleChange} schemaVersion={schemaVersion} />
    </div>
  );
}
