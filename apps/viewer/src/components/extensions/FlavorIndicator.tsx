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
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';
import { localizedFlavorDescription, localizedFlavorName } from './localized-flavor-metadata';

interface FlavorIndicatorProps {
  onClick?: () => void;
}

export function FlavorIndicator({ onClick }: FlavorIndicatorProps) {
  const { t } = useTranslation();
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

  const name = flavor ? localizedFlavorName(flavor, t) : undefined;
  const description = flavor ? localizedFlavorDescription(flavor, t) : undefined;
  const label = name ?? t('extensionsFlavors.flavorIndicator.defaultLabel');
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
          ? t('extensionsFlavors.flavorIndicator.activeAriaLabel', { name: name ?? flavor.name })
          : t('extensionsFlavors.flavorIndicator.inactiveAriaLabel')
      }
      title={
        flavor
          ? description
            ? t('extensionsFlavors.flavorIndicator.activeTitleWithDescription', { name: name ?? flavor.name, description })
            : t('extensionsFlavors.flavorIndicator.activeTitle', { name: name ?? flavor.name })
          : t('extensionsFlavors.flavorIndicator.inactiveTitle')
      }
      className={cn(
        // Width (~71px) already clears 24px; the chip's own height (~21px)
        // is short by ~3px (#5826). `inset-x-0` keeps width unchanged — the
        // surrounding row separates items with dedicated `Separator`s, so
        // only height needs the hit-slop.
        'relative flex items-center gap-1 rounded-md border px-1.5 py-0.5 transition-colors after:absolute after:inset-x-0 after:-top-0.5 after:-bottom-0.5 after:content-[\'\'] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        flavor
          ? 'border-primary/40 bg-primary/5 text-foreground hover:bg-primary/10'
          : 'border-dashed border-muted-foreground/40 text-muted-foreground hover:bg-muted/60 hover:text-foreground',
      )}
    >
      <Palette className="h-3.5 w-3.5" />
      <span className="max-w-[140px] truncate text-2xs font-medium">{label}</span>
    </button>
  );
}
