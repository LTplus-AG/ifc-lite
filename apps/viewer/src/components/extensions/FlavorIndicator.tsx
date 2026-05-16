/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `FlavorIndicator` — status-bar chip showing the active flavor.
 *
 * Reads from the extension host's `FlavorService`. Re-renders on
 * flavor changes (activate, import, switch). Clicking opens the
 * flavor switcher — for Phase 3 that surfaces the export/import
 * dialog; the merge UI lands in T13.
 *
 * Spec: docs/architecture/ai-customization/05-flavors-and-sharing.md §4.
 */

import { useEffect, useState } from 'react';
import { Palette } from 'lucide-react';
import type { Flavor } from '@ifc-lite/extensions';
import { useOptionalExtensionHost } from '@/sdk/ExtensionHostProvider';

interface FlavorIndicatorProps {
  onClick?: () => void;
}

export function FlavorIndicator({ onClick }: FlavorIndicatorProps) {
  const host = useOptionalExtensionHost();
  const [flavor, setFlavor] = useState<Flavor | undefined>();

  useEffect(() => {
    if (!host) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const next = await host.flavors.getActive();
        if (!cancelled) setFlavor(next);
      } catch (err) {
        console.warn('[FlavorIndicator] getActive failed:', err);
      }
    };
    void refresh();
    const off = host.flavors.onChange(() => {
      void refresh();
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [host]);

  if (!host) return null;

  const label = flavor?.name ?? 'Default';
  return (
    <button
      type="button"
      onClick={onClick}
      title={
        flavor
          ? `Active flavor: ${flavor.name}${flavor.description ? ` — ${flavor.description}` : ''}`
          : 'No flavor active (baseline)'
      }
      className="flex items-center gap-1 rounded-sm px-1.5 py-0.5 hover:bg-muted/60 transition-colors"
    >
      <Palette className="h-3.5 w-3.5" />
      <span className="max-w-[140px] truncate">{label}</span>
    </button>
  );
}
