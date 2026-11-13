/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useRef, useState } from 'react';
import type { PagedItems } from './sourceCatalogPaging';

/** Publish pages and their persistence snapshot together, before React commits.
 * Concurrent listings must see each other's writes even in the same batch. */
export function useCatalogPages<T>() {
  const current = useRef(new Map<string, PagedItems<T>>());
  const [pages, setPages] = useState(current.current);
  const replace = useCallback((next: Map<string, PagedItems<T>>) => {
    current.current = next;
    setPages(next);
  }, []);
  const setPage = useCallback((key: string, page: PagedItems<T>) => {
    replace(new Map(current.current).set(key, page));
  }, [replace]);
  return { pages, current, replace, setPage };
}
