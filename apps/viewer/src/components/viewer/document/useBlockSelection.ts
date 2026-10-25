/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState } from 'react';
import type { DocumentSpec } from '@/lib/document/types';

/** Selection is transient and belongs to an authored document, never a page fragment. */
export function useBlockSelection(document: DocumentSpec | null) {
  const [selection, setSelection] = useState<{ documentId: string | undefined; ids: ReadonlySet<string> }>({ documentId: undefined, ids: new Set() });
  const documentId = document?.id;
  const liveIds = new Set(document?.blocks.map(block => block.id));
  const ids = new Set(selection.documentId === documentId ? [...selection.ids].filter(id => liveIds.has(id)) : []);
  useEffect(() => {
    setSelection(prior => {
      const next = new Set(prior.documentId === documentId ? [...prior.ids].filter(id => document?.blocks.some(block => block.id === id)) : []);
      return prior.documentId === documentId && next.size === prior.ids.size ? prior : { documentId, ids: next };
    });
  }, [documentId, document?.blocks]);
  const selectOnly = (id: string) => setSelection({ documentId, ids: new Set([id]) });
  const toggle = (id: string) => {
    if (!liveIds.has(id)) return;
    setSelection(prior => {
      const next = new Set(prior.documentId === documentId ? [...prior.ids].filter(value => liveIds.has(value)) : []);
      if (next.has(id)) next.delete(id); else next.add(id);
      return { documentId, ids: next };
    });
  };
  return { ids, selectOnly, toggle };
}
