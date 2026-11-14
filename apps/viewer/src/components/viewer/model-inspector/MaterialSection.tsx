/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { materialColour } from '@/lib/authoring/material-colour';
import { readRelatedLists } from '@ifc-lite/create';
import { useViewerStore } from '@/store';
import { materialsOf, type LiveModel } from '@/lib/commands/modeling/authored-kinds';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { InspectorSection } from './InspectorControls';
import { setElementMaterial } from './inspector-edits';
import { useTranslation } from '@/i18n';

export function MaterialSection({ modelId, elementId, live }: { modelId: string; elementId: number; live: LiveModel }) {
  useViewerStore(s => s.mutationVersion);
  const { t } = useTranslation();
  const materials = materialsOf(live);
  const current = readRelatedLists(live.dataStore, 'IfcRelAssociatesMaterial', live.view).find(r => r.relatedIds.includes(elementId))?.relatingId;
  return <InspectorSection title={t('propertyEditor.material.picker')}>
    <Select value={current === undefined ? '' : String(current)} onValueChange={id => setElementMaterial(modelId, elementId, Number(id))}>
      <SelectTrigger aria-label={t('propertyEditor.material.name')}><SelectValue placeholder={t('modelInspector.layers.noMaterial')} /></SelectTrigger>
      <SelectContent>{materials.map(m => <SelectItem key={m.expressId} value={String(m.expressId)}><span aria-hidden className="mr-2 inline-block h-3 w-3 rounded border" style={{ backgroundColor: materialColour(live, m.expressId) }} />{m.name}</SelectItem>)}</SelectContent>
    </Select>
  </InspectorSection>;
}
