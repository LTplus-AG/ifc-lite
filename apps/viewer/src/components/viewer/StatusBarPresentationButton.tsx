/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The status bar's Presentation entry point (#5508), replacing
 * `BasketPresentationDock`'s always-on floating pill at the viewport's
 * bottom-center. `basketPresentationVisible` is the `presentation`
 * bottom panel's dock flag (`lib/panels/bottom-panels.ts`); toggling routes
 * through `toggleBottomPanel` so it stays mutually exclusive with the other
 * bottom panels instead of the raw flag setter.
 *
 * Split out of `StatusBar.tsx` to keep that module under its size budget,
 * the same reason `FlavorIndicator` is its own component there.
 */
import { Presentation } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';

export function StatusBarPresentationButton() {
  const { t } = useTranslation();
  const pinboardEntities = useViewerStore((s) => s.pinboardEntities);
  const basketViewCount = useViewerStore((s) => s.basketViews.length);
  const basketPresentationVisible = useViewerStore((s) => s.basketPresentationVisible);
  const toggleBottomPanel = useViewerStore((s) => s.toggleBottomPanel);

  return (
    <button
      type="button"
      onClick={() => toggleBottomPanel('presentation')}
      aria-pressed={basketPresentationVisible}
      title={t('shellChrome.statusBar.presentationTooltip', { views: basketViewCount, entities: pinboardEntities.size })}
      className={cn(
        // Width (~71px) already clears 24px; the status bar's compact text
        // height (~16px) does not (#5826). `inset-x-0` keeps width
        // unchanged — the surrounding row separates items with dedicated
        // `Separator`s, so only height needs the hit-slop.
        'relative flex items-center gap-1.5 rounded px-1 -mx-1 transition-colors hover:text-foreground after:absolute after:inset-x-0 after:-top-1 after:-bottom-1 after:content-[\'\'] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        basketPresentationVisible && 'text-foreground',
      )}
    >
      <Presentation className="h-3.5 w-3.5" />
      <span>{t('shellChrome.statusBar.presentationLabel')}</span>
      {(basketViewCount > 0 || pinboardEntities.size > 0) && (
        <span className="tabular-nums">
          {basketViewCount > 0 ? `${basketViewCount}/${pinboardEntities.size}` : pinboardEntities.size}
        </span>
      )}
    </button>
  );
}
