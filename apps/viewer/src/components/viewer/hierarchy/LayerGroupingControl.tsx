/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useTranslation } from '@/i18n';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { LayerGrouping } from './presentationLayerGroups';

export function LayerGroupingControl({ value, onChange }: {
  value: LayerGrouping; onChange: (value: LayerGrouping) => void;
}) {
  const { t } = useTranslation();
  return <Select value={value}
    onValueChange={next => {
      if (next === 'none' || next === 'class' || next === 'classification') onChange(next);
    }}>
    <SelectTrigger aria-label={t('hierarchy.layerGrouping.label')}
      className="h-6 w-auto max-w-36 gap-1 bg-background px-1.5 py-0 text-xs">
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      <SelectItem value="none">{t('hierarchy.layerGrouping.none')}</SelectItem>
      <SelectItem value="class">{t('hierarchy.layerGrouping.class')}</SelectItem>
      <SelectItem value="classification">{t('hierarchy.layerGrouping.classification')}</SelectItem>
    </SelectContent>
  </Select>;
}
