/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Subscribe a React component to a slot in the extension SlotRegistry.
 *
 * Re-renders whenever an extension registers or unregisters
 * contributions for the named slot. Returns the current list,
 * snapshot-style, in registration order.
 */

import { useEffect, useState } from 'react';
import type { SlotContribution } from '@ifc-lite/extensions';
import { useOptionalExtensionHost } from '@/sdk/ExtensionHostProvider.js';

export function useSlotContributions<T = unknown>(slot: string): SlotContribution<T>[] {
  const host = useOptionalExtensionHost();
  const [items, setItems] = useState<SlotContribution<T>[]>(
    () => host?.getSlotContributions<T>(slot) ?? [],
  );

  useEffect(() => {
    if (!host) {
      setItems([]);
      return;
    }
    // Refresh snapshot synchronously before subscribing — otherwise
    // switching slots can leave old contributions visible until the
    // next registry event arrives.
    setItems(host.getSlotContributions<T>(slot));
    return host.subscribeSlot<T>(slot, (next) => {
      setItems(next);
    });
  }, [host, slot]);

  return items;
}
