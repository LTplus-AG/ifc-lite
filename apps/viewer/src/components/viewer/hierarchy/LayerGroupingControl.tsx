/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useTranslation } from '@/i18n';
import type { LayerGrouping } from './presentationLayerGroups';

export function LayerGroupingControl({ value, onChange }: {
  value: LayerGrouping; onChange: (value: LayerGrouping) => void;
}) {
  const { t } = useTranslation();
  return <select aria-label={t('hierarchy.layerGrouping.label')} value={value}
    className="h-6 max-w-36 bg-background text-xs"
    onChange={event => {
      const next = event.target.value;
      if (next === 'none' || next === 'class' || next === 'classification') onChange(next);
    }}>
    <option value="none">{t('hierarchy.layerGrouping.none')}</option>
    <option value="class">{t('hierarchy.layerGrouping.class')}</option>
    <option value="classification">{t('hierarchy.layerGrouping.classification')}</option>
  </select>;
}
