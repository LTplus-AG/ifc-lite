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
  // Slightly more emphasised treatment than the surrounding status
  // bar items so the entry to the flavor system is visible without
  // an animated walkthrough. Bordered chip + foreground text on
  // active, muted on default.
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={
        flavor
          ? `Active flavor: ${flavor.name}. Click to manage flavors.`
          : 'No active flavor. Click to manage flavors.'
      }
      title={
        flavor
          ? `Flavors — switchable profiles of your extensions, lenses, queries, and overlay.\nActive: ${flavor.name}${flavor.description ? `\n${flavor.description}` : ''}\nClick to switch / export / import / merge.`
          : 'Flavors — switchable profiles of your extensions, lenses, and settings.\nClick to manage.'
      }
      className={
        flavor
          ? 'flex items-center gap-1 rounded-md border border-primary/40 bg-primary/5 px-1.5 py-0.5 text-foreground hover:bg-primary/10 transition-colors'
          : 'flex items-center gap-1 rounded-md border border-dashed border-muted-foreground/40 px-1.5 py-0.5 text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors'
      }
    >
      <Palette className="h-3.5 w-3.5" />
      <span className="max-w-[140px] truncate text-[11px] font-medium">{label}</span>
    </button>
  );
}
