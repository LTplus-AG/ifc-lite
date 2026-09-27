/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useState } from 'react';

const PREFIX = 'ifc-lite:properties:section:';

function readDisclosure(id: string, defaultOpen: boolean): boolean {
  try {
    if (typeof localStorage === 'undefined') return defaultOpen;
    const saved = localStorage.getItem(PREFIX + id);
    return saved === null ? defaultOpen : saved === 'open';
  } catch (error) {
    console.warn('[Properties] Could not read section preference:', error);
    return defaultOpen;
  }
}

/** A section id names the same disclosure across selections and reloads (#5899). */
export function usePersistentDisclosure(id: string, defaultOpen = true): [boolean, (next: boolean) => void] {
  const [open, setOpen] = useState(() => readDisclosure(id, defaultOpen));
  useEffect(() => setOpen(readDisclosure(id, defaultOpen)), [id, defaultOpen]);
  const changeOpen = useCallback((next: boolean) => {
    setOpen(next);
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(PREFIX + id, next ? 'open' : 'closed');
    } catch (error) {
      console.warn('[Properties] Could not save section preference:', error);
    }
  }, [id]);
  return [open, changeOpen];
}
