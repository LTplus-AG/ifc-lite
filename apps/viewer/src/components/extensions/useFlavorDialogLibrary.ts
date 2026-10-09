/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Flavor } from '@ifc-lite/extensions';
import type { ExtensionHostService } from '@/services/extensions/host';

type ReadPhase = 'loading' | 'ready' | 'unavailable';
export function useFlavorDialogLibrary(host: ExtensionHostService, open: boolean) {
  const current = useRef({ host, open: false });
  const reopening = open && (!current.current.open || current.current.host !== host);
  current.current = { host, open };
  const sequence = useRef(0);
  const [library, setLibrary] = useState<{ host: ExtensionHostService; flavors: Flavor[]; activeId?: string; phase: ReadPhase }>({ host, flavors: [], phase: 'loading' });
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    const wanted = () => current.current.host === host && current.current.open && request === sequence.current;
    setLibrary(previous => ({ ...previous, phase: 'loading' }));
    try {
      const [flavors, active] = await Promise.all([host.flavors.list(), host.flavors.getActive()]);
      if (wanted()) setLibrary({ host, flavors, activeId: active?.id, phase: 'ready' });
    } catch (error) {
      console.warn('[Profiles] Native profile library could not be read', error);
      if (wanted()) setLibrary(previous => ({ ...previous, phase: 'unavailable' }));
    }
  }, [host]);
  useEffect(() => {
    if (!open) return;
    void refresh();
    const off = host.flavors.onChange(() => void refresh());
    return () => { sequence.current++; off(); };
  }, [host, open, refresh]);
  return { ...(library.host === host && !reopening ? library : { flavors: [], activeId: undefined, phase: 'loading' as const }), refresh };
}
