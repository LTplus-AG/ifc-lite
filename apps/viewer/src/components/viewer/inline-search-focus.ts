/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useLayoutEffect, useState, useSyncExternalStore, type RefObject } from 'react';
import { registerKeyboardCommand } from '@/lib/commands/dispatcher';
import { useViewerStore } from '@/store';

let host: (() => void) | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const read = () => host;
const publish = () => { for (const listener of listeners) listener(); };
export const useInlineSearchHost = () => useSyncExternalStore(subscribe, read, read);
export const hasInlineSearchHost = () => host !== null;
export function focusInlineSearch(): void {
  if (!host) throw new Error('Inline search has no mounted host');
  host();
}

/** Both surfaces call the live field owner; no synthetic keyboard dispatch (#8947). */
export function useInlineSearchFocus(input: RefObject<HTMLInputElement | null>): void {
  const [request, setRequest] = useState(0);
  const focus = useCallback(() => {
    useViewerStore.getState().setSearchOpen(true);
    setRequest(value => value + 1);
  }, []);
  // A mobile field can be hidden before the request. Focus after React reveals
  // it, and after the palette has released its modal focus scope.
  useLayoutEffect(() => {
    if (!request) return;
    input.current?.focus();
    input.current?.select();
  }, [input, request]);
  useEffect(() => {
    host = focus;
    publish();
    const remove = registerKeyboardCommand('search.focus', focus,
      { allowInTextEntry: event => event.ctrlKey || event.metaKey });
    return () => { remove(); if (host === focus) { host = null; publish(); } };
  }, [focus]);
}
