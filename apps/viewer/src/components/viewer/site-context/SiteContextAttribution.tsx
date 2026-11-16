/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The data owners' attribution, in the viewport, for as long as any
 * site-context model is visible. swisstopo's terms make the source reference
 * mandatory wherever the data is shown, so this is not a setting: it appears
 * with the first visible context model and goes with the last.
 *
 * It reads the model records, not the fetch, so a site-context GLB dropped on
 * the viewer is attributed exactly like a fetched one, and the imagery's own
 * line appears once it is draped.
 */

import { useMemo } from 'react';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { visibleSiteContextModels } from '@/store/slices/siteContextSlice';

/** The distinct attribution texts of the visible context models, in first-seen order. */
export function siteContextAttributionTexts(
  records: Parameters<typeof visibleSiteContextModels>[0],
  models: Parameters<typeof visibleSiteContextModels>[1],
): string[] {
  const texts: string[] = [];
  for (const [, info] of visibleSiteContextModels(records, models)) {
    for (const entry of info.attribution) if (!texts.includes(entry.text)) texts.push(entry.text);
    if (info.imagery && !texts.includes(info.imagery.attribution.text)) texts.push(info.imagery.attribution.text);
  }
  return texts;
}

export function SiteContextAttribution() {
  const { t } = useTranslation();
  const records = useViewerStore((s) => s.siteContextModels);
  const models = useViewerStore((s) => s.models);
  const texts = useMemo(() => siteContextAttributionTexts(records, models), [records, models]);
  if (texts.length === 0) return null;
  // Wraps rather than truncates: attribution is a licence condition, so no source may be cut off
  // behind an ellipsis on a narrow viewport (#10481 review).
  return (
    <p
      aria-label={t('siteContext.attribution.label')}
      data-testid="site-context-attribution"
      className="pointer-events-none absolute bottom-1 right-2 max-w-[60%] whitespace-normal break-words rounded bg-background/70 px-1.5 py-0.5 text-2xs text-foreground/80 backdrop-blur-sm"
    >
      {texts.join(' · ')}
    </p>
  );
}
