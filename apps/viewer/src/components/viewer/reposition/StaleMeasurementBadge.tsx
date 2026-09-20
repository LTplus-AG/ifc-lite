/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
export function StaleMeasurementBadge({ id }: { id: string }) {
  const { t } = useTranslation();
  const stale = useViewerStore((state) => state.placementStaleMeasurements.has(id));
  return stale ? <span className="text-amber-700" title={t('repositionPanel.staleBadge.title')}>{' · '}{t('repositionPanel.staleBadge.label')}</span> : null;
}
