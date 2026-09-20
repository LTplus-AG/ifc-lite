/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState } from 'react';
import type { Flavor } from '@ifc-lite/extensions';
import type { ExtensionHostService } from '@/services/extensions/host';

/** Subscribe to the flavor record so callers retain its stable id for localization. */
export function useActiveFlavor(host: ExtensionHostService): Flavor | undefined {
  const [activeFlavor, setActiveFlavor] = useState<Flavor | undefined>();
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const flavor = await host.flavors.getActive();
        if (!cancelled) setActiveFlavor(flavor);
      } catch (error) {
        console.warn('[ExtensionsPanel] active flavor refresh failed:', error);
      }
    };
    void refresh();
    const off = host.flavors.onChange(() => void refresh());
    return () => { cancelled = true; off(); };
  }, [host]);
  return activeFlavor;
}
