/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { AppearanceAssignment } from '@/lib/appearance/assignments/types.js';
import type { AppearanceAssignmentListProps } from './AppearanceAssignmentList.js';

const PAGE_SIZE = 50;

/** Mount only for the expanded assignment. Scope size never becomes DOM size. */
export function AppearanceAssignmentMembers({ assignment, disabled, objectName, onExclude }:
  Pick<AppearanceAssignmentListProps, 'disabled' | 'objectName' | 'onExclude'> & { assignment: AppearanceAssignment }) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const search = useDeferredValue(query.trim().toLocaleLowerCase());
  const { members, model, excludedGlobalIds } = assignment;
  const matches = useMemo(() => search ? members.filter(product =>
    product.GlobalId.toLocaleLowerCase().includes(search)
      || objectName(model.modelId, product.expressId).toLocaleLowerCase().includes(search)) : members,
  [members, model.modelId, objectName, search]);
  const excluded = useMemo(() => new Set(excludedGlobalIds), [excludedGlobalIds]);
  const lastPage = Math.max(0, Math.ceil(matches.length / PAGE_SIZE) - 1);
  const currentPage = Math.min(page, lastPage);
  const start = currentPage * PAGE_SIZE;
  const visible = matches.slice(start, start + PAGE_SIZE);
  const pending = search !== query.trim().toLocaleLowerCase();
  const viewport = useRef<HTMLDivElement>(null);
  useEffect(() => { if (viewport.current) viewport.current.scrollTop = 0; }, [currentPage, search]);

  return <div className="mt-2 space-y-2 text-[11px]">
    <label className="block space-y-1"><span>Find an object</span>
      <Input type="search" className="h-7 text-xs" placeholder="Name or GlobalId" value={query} disabled={disabled}
        onChange={event => { setQuery(event.currentTarget.value); setPage(0); }} />
    </label>
    <div ref={viewport} role="group" aria-label="Objects in this assignment" aria-busy={pending} className="max-h-48 space-y-1 overflow-y-auto">
      {visible.map(product => <label key={product.GlobalId} className="flex items-start gap-2 rounded px-1 py-1 hover:bg-muted">
        <input type="checkbox" className="mt-0.5" disabled={disabled || pending} checked={!excluded.has(product.GlobalId)}
          onChange={event => onExclude(assignment.id, product.GlobalId, !event.currentTarget.checked)} />
        <span className="min-w-0"><span className="block truncate">{objectName(model.modelId, product.expressId)}</span>
          <span className="block truncate text-[10px] text-muted-foreground">{product.GlobalId}</span></span>
      </label>)}
    </div>
    <div className="flex items-center justify-between gap-1">
      <p role="status">{matches.length ? `${start + 1}–${start + visible.length} of ${matches.length}` : 'No matching objects'}</p>
      {matches.length > PAGE_SIZE && <div className="flex gap-1">
        <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-[11px]" aria-label="Previous objects"
          disabled={disabled || pending || currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</Button>
        <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-[11px]" aria-label="Next objects"
          disabled={disabled || pending || currentPage === lastPage} onClick={() => setPage(currentPage + 1)}>Next</Button>
      </div>}
    </div>
  </div>;
}
