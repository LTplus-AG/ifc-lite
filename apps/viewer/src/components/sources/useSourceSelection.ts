/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useCallback, useEffect, useState } from 'react';
import type { SourceFile } from '@ifc-lite/plugin-api';

/** A pinned historical choice survives catalog refresh; missing resources drop out. */
export function useSourceSelection(files: readonly SourceFile[], search: readonly SourceFile[]) {
  const [selectedFiles, setSelectedFiles] = useState<Map<string, SourceFile>>(new Map());
  const toggleFile = useCallback((file: SourceFile) => {
    if (file.unavailableReason) return;
    setSelectedFiles((prev) => {
      const next = new Map(prev);
      if (next.has(file.id)) next.delete(file.id);
      else next.set(file.id, file);
      return next;
    });
  }, []);
  const selectRevision = useCallback((file: SourceFile) => {
    if (file.unavailableReason) return;
    setSelectedFiles((prev) => new Map(prev).set(file.id, file));
  }, []);
  useEffect(() => {
    const byId = new Map([...files, ...search].map((file) => [file.id, file] as const));
    setSelectedFiles((previous) => {
      let changed = false;
      const next = new Map<string, SourceFile>();
      for (const [id, file] of previous) {
        const fresh = byId.get(id);
        if (!fresh || fresh.unavailableReason) { changed = true; continue; }
        const selected = file.meta?.selectedRevisionId ? file : fresh;
        next.set(id, selected);
        if (selected !== file) changed = true;
      }
      return changed ? next : previous;
    });
  }, [files, search]);
  return { selectedFiles, setSelectedFiles, toggleFile, selectRevision };
}
