/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ObjectCountSummary } from './objectCountSummary';
import { useTranslation } from '@/i18n';

/** The hover card behind a tree row's count badge — headline first, then only
 *  the breakdown lines that have something to say. Spatial rows arrive with
 *  every other row falls back to the plain wording for whatever its badge counts. */
export function CountBadgeTooltip({
  elementCount,
  summary,
}: {
  elementCount: number;
  summary?: ObjectCountSummary;
}) {
  const { t } = useTranslation();
  const headline = summary
    ? t('hierarchy.countBadge.objects', { count: summary.counted, formatted: summary.counted.toLocaleString() })
    : t('hierarchy.countBadge.elements', { count: elementCount, formatted: elementCount.toLocaleString() });
  const rest = summary ? [
    summary.typeCounts.length > 0
      ? summary.typeCounts.map(([type, count]) => `${count.toLocaleString()} ${type}`).join(' · ')
      : null,
    !summary.geometryKnown ? t('hierarchy.countBadge.loadingGeometry') : null,
    summary.withoutGeometry > 0
      ? t('hierarchy.countBadge.withoutGeometry', { count: summary.withoutGeometry, formatted: summary.withoutGeometry.toLocaleString() })
      : null,
    summary.spacesNotCounted > 0
      ? t('hierarchy.countBadge.spacesNotCounted', { count: summary.spacesNotCounted, formatted: summary.spacesNotCounted.toLocaleString() })
      : null,
  ].filter((line): line is string => line !== null) : [];
  return (
    <>
      <p className="text-xs">{headline}</p>
      {/* TooltipContent uses the neutral popover surface; secondary copy uses
          its semantic muted token instead of a hardcoded zinc shade. */}
      {rest.map((line) => (
        <p key={line} className="text-[10px] text-muted-foreground">{line}</p>
      ))}
    </>
  );
}
