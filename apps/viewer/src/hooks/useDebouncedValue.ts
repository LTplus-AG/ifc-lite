/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState } from 'react';

/**
 * The value, but only after it has held still for `delayMs`.
 *
 * Split out of LocationMap.tsx (past the ~400-line rule), where it keeps the
 * place-search from firing a geocoder request per keystroke. Generic enough to
 * live with the other hooks rather than inside one panel.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
