/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useEffect, useMemo, useState } from 'react';
import { iterateEffectiveEntityIds } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { listExportModels, resolveExportModel } from '../export-model-selection';
import { preferredExportModelId } from '../export-model-default';
import { effectiveListStringAttribute } from '@/lib/lists/effective-provider-entities';
import { bindAlignment, useAlignmentToolState } from '@/lib/section/alignment-controller';

export function AlignmentSectionControls() {
  const { t } = useTranslation();
  const models = useViewerStore(s => s.models);
  const legacyStore = useViewerStore(s => s.ifcDataStore);
  const legacyGeometry = useViewerStore(s => s.geometryResult);
  const activeModel = useViewerStore(s => s.activeModelId);
  const version = useViewerStore(s => s.mutationVersion);
  const views = useViewerStore(s => s.mutationViews);
  const binding = useViewerStore(s => s.sectionPlane.custom?.alignment);
  const tool = useAlignmentToolState();
  const [modelId, setModelId] = useState(binding?.modelId ?? activeModel ?? '');
  const candidates = useMemo(() => listExportModels(models, new Set(), legacyStore)
    .filter(model => model.schemaVersion !== 'IFC5' && !model.sourceSchema), [models, legacyStore]);
  useEffect(() => {
    if (binding) setModelId(binding.modelId);
    else if (!candidates.some(model => model.id === modelId)) {
      setModelId(preferredExportModelId(candidates.map(model => model.id), activeModel));
    }
  }, [binding, candidates, modelId, activeModel]);
  const axes = useMemo(() => {
    const model = resolveExportModel(models, modelId, legacyStore, legacyGeometry);
    const store = model?.ifcDataStore;
    if (!store) return [];
    const view = views.get(modelId);
    return [...iterateEffectiveEntityIds(store, view, ['IfcAlignment'])].map(row => ({
      expressId: row.expressId,
      Name: effectiveListStringAttribute(store, view, row.expressId, 'Name', () => store.entities.getName(row.expressId)),
    }));
  }, [models, modelId, legacyStore, legacyGeometry, views, version]);

  if (!tool.choosing && !binding) return null;
  return <span className="flex flex-wrap items-center gap-1">
    <Select value={modelId} onValueChange={setModelId} disabled={tool.busy}>
      <SelectTrigger className="h-7 w-36 text-xs" aria-label={t('alignmentSection.model')}><SelectValue placeholder={t('alignmentSection.model')} /></SelectTrigger>
      <SelectContent>{candidates.map(model => <SelectItem key={model.id} value={model.id}>{model.name}</SelectItem>)}</SelectContent>
    </Select>
    <Select value={binding?.modelId === modelId ? String(binding.expressId) : ''}
      onValueChange={value => { void bindAlignment(modelId, Number(value)); }} disabled={tool.busy || axes.length === 0}>
      <SelectTrigger className="h-7 w-40 text-xs" aria-label={t('alignmentSection.axis')}><SelectValue placeholder={t(axes.length ? 'alignmentSection.axis' : 'alignmentSection.noAxes')} /></SelectTrigger>
      <SelectContent>{axes.map(axis => <SelectItem key={axis.expressId} value={String(axis.expressId)}>
        {axis.Name || t('alignmentSection.axisFallback', { id: axis.expressId })}
      </SelectItem>)}</SelectContent>
    </Select>
    <span className="text-2xs text-muted-foreground" title={t('alignmentSection.help')}>
      {t(tool.busy ? 'alignmentSection.loading' : tool.metadata?.approximate ? 'alignmentSection.approximate' : 'alignmentSection.distance')}
    </span>
    {tool.error && <output className="max-w-64 text-xs text-destructive" aria-live="polite">{t('alignmentSection.error', { detail: tool.error })}</output>}
  </span>;
}
