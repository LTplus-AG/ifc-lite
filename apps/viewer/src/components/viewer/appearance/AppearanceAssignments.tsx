/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { AppearanceMembershipChanges } from './AppearanceMembershipChanges.js';
import { Button } from '@/components/ui/button';
import { useViewerStore } from '@/store';
import { AppearanceAssignmentList } from './AppearanceAssignmentList.js';
import type { useAppearanceAssignments } from './useAppearanceAssignments.js';
import type { AppearancePanelViewProps } from './types.js';
import type { AppearanceAssignment } from '@/lib/appearance/assignments/types.js';
import { useTranslation, type TranslationKey, type TranslationParameters } from '@/i18n';
import { resolveLocalizedMessage } from './localized-message.js';

type Controller = ReturnType<typeof useAppearanceAssignments>;
/** `t` is threaded in explicitly: this is a plain (non-component) helper, so
 *  it cannot call the `useTranslation` hook itself. */
function queryLabel(row: AppearanceAssignment, t: (key: TranslationKey, params?: TranslationParameters) => string): string {
  const query = row.query;
  return query.kind === 'model' ? t('appearance.assignments.queryWholeModel') : query.kind === 'selection' ? t('appearance.assignments.querySelectedObjects')
    : query.kind === 'class' ? query.ifcClass : query.kind === 'filter' ? t('appearance.assignments.queryFilter', { name: query.query.name }) : t('appearance.assignments.queryIfcType', { globalId: query.GlobalId });
}
const summaryKeys = {
  row: {
    model: 'appearance.assignments.rowSummaryModel', selection: 'appearance.assignments.rowSummarySelection',
    class: 'appearance.assignments.rowSummaryClass', filter: 'appearance.assignments.rowSummaryFilter',
    type: 'appearance.assignments.rowSummaryIfcType',
  },
  mapped: {
    model: 'appearance.assignments.rowSummaryMappedModel', selection: 'appearance.assignments.rowSummaryMappedSelection',
    class: 'appearance.assignments.rowSummaryMappedClass', filter: 'appearance.assignments.rowSummaryMappedFilter',
    type: 'appearance.assignments.rowSummaryMappedIfcType',
  },
  review: {
    model: 'appearance.assignments.reviewRowSummaryModel', selection: 'appearance.assignments.reviewRowSummarySelection',
    class: 'appearance.assignments.reviewRowSummaryClass', filter: 'appearance.assignments.reviewRowSummaryFilter',
    type: 'appearance.assignments.reviewRowSummaryIfcType',
  },
} as const;
function summaryMessage(row: AppearanceAssignment, variant: keyof typeof summaryKeys) {
  const query = row.query;
  const key = summaryKeys[variant][query.kind];
  const base = { modelName: row.model.name };
  if (query.kind === 'class') return { key, params: { ...base, ifcClass: query.ifcClass } };
  if (query.kind === 'filter') return { key, params: { ...base, name: query.query.name } };
  if (query.kind === 'type') return { key, params: { ...base, globalId: query.GlobalId } };
  return { key, params: base };
}
function ReviewBinding({ row, controller, base }: { row: AppearanceAssignment; controller: Controller; base: AppearancePanelViewProps }) {
  const { t } = useTranslation();
  const { modelId, sourceId } = controller.binding(row);
  return <div className="space-y-2 rounded border p-2 text-xs">
    <p className="font-medium">{row.model.name} · {queryLabel(row, t)}</p>
    <p className="text-2xs text-muted-foreground">{t('appearance.assignments.bindingDescription')}</p>
    <label className="block">{t('appearance.assignments.loadedModelLabel')}<select className="mt-1 w-full rounded border bg-background p-1" value={modelId}
      disabled={controller.busy} onChange={event => controller.setBinding(row.id, { modelId: event.currentTarget.value })}>
      <option value="">{t('appearance.assignments.chooseLoadedModel')}</option>
      {!base.models.some(model => model.id === modelId) && modelId && <option value={modelId} disabled>{t('appearance.assignments.unavailableModel', { name: row.model.name })}</option>}
      {base.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
    </select></label>
    <label className="block">{t('appearance.assignments.originalSourceLabel')}<select className="mt-1 w-full rounded border bg-background p-1" value={sourceId}
      disabled={controller.busy} onChange={event => controller.setBinding(row.id, { sourceId: event.currentTarget.value })}>
      <option value="">{t('appearance.assignments.chooseOriginalSource')}</option>
      {!base.sources.some(source => source.id === sourceId) && sourceId && <option value={sourceId} disabled>{t('appearance.assignments.unavailableSource', { name: row.source.name })}</option>}
      {base.sources.map(source => <option key={source.id} value={source.id}>{source.name}</option>)}
    </select></label>
    <Button size="sm" variant="outline" disabled={controller.busy || !controller.canReview(row.id)} onClick={() => controller.reviewRow(row.id)}>{t('appearance.assignments.reviewCurrentScope')}</Button>
  </div>;
}
export function AppearanceAssignments({ controller: c, base, formValid = true }: { controller: Controller; base: AppearancePanelViewProps; formValid?: boolean }) {
  const { t } = useTranslation();
  const objectName = (modelId: string, expressId: number) => useViewerStore.getState().models.get(modelId)?.ifcDataStore?.entities.getName(expressId) || t('appearance.assignments.ifcObjectFallbackName', { expressId });
  return <section className="space-y-3 border-t pt-3" aria-label={t('appearance.assignments.sectionAriaLabel')}>
    <div><h3 className="text-xs font-semibold">{t('appearance.assignments.heading')}</h3>
      <p className="mt-1 text-2xs text-muted-foreground">{t('appearance.assignments.description')}</p></div>
    <Button variant="outline" size="sm" className="w-full" disabled={!formValid || c.busy || base.sourceBusy || !!base.unavailableReason || !base.modelId || !base.sourceId}
      onClick={c.add}>{t('appearance.assignments.addScope')}</Button>
    {!formValid && <p className="text-2xs text-destructive">{t('appearance.assignments.invalidNotice')}</p>}
    {!!c.rows.length && <>
      <AppearanceAssignmentList rows={c.resolved} disabled={c.busy} objectName={objectName}
        onMove={c.move} onRemove={c.remove} onExclude={(id, GlobalId, excluded) => c.change(id, row => ({ ...row,
          excludedGlobalIds: excluded ? [...row.excludedGlobalIds, GlobalId] : row.excludedGlobalIds.filter(guid => guid !== GlobalId) }))} />
      {c.rows.map(row => c.bound(row.id) ? <p key={row.id} className="text-2xs text-muted-foreground">{(() => {
        const summary = summaryMessage(row, row.settings.representationPolicy === 'evaluatedOccurrence' ? 'mapped' : 'row');
        return t(summary.key, summary.params);
      })()}</p>
        : <ReviewBinding key={row.id} row={row} controller={c} base={base} />)}
      {c.review && <section aria-label={t('appearance.assignments.reviewAriaLabel')} className="space-y-2 rounded border bg-muted/30 p-2 text-xs">
        {c.review.map(item => <div key={item.proposed.assignment.id}>
          <p>{(() => { const summary = summaryMessage(item.proposed.assignment, 'review'); return t(summary.key, summary.params); })()}</p>
          <p>{t('appearance.assignments.reviewChanges', { added: item.changes.added.length, removed: item.changes.removed.length, renumbered: item.changes.renumbered.length })}</p>
          <AppearanceMembershipChanges review={item} />
          {item.sourceModelChanged && <p>{t('appearance.assignments.sourceModelChanged')}</p>}
          {!!item.removedExclusions.length && <p>{t('appearance.assignments.removedExclusionsNotice', { count: item.removedExclusions.length })}</p>}
        </div>)}
        <Button size="sm" disabled={c.busy} onClick={c.acceptReview}>{t('appearance.assignments.acceptReview')}</Button>
      </section>}
      <Button className="w-full" size="sm" variant="outline" disabled={c.busy || !!c.blockedReason || c.rows.some(row => !c.bound(row.id))}
        onClick={c.previewAll}>{t('appearance.assignments.previewAll')}</Button>
    </>}
    <div className="flex items-center gap-2">
      <Button size="sm" variant="ghost" disabled={c.busy || !c.rows.length} onClick={c.download}>{t('appearance.assignments.saveRecipe')}</Button>
      <label className="cursor-pointer text-xs underline">{t('appearance.assignments.restoreRecipe')}<input aria-label={t('appearance.assignments.restoreRecipeAriaLabel')} type="file" accept="application/json,.json"
        className="sr-only" disabled={c.busy} onChange={event => { const file = event.currentTarget.files?.[0]; if (file) c.restore(file); event.currentTarget.value = ''; }} /></label>
    </div>
    {!c.rows.length && <p role={c.status === 'error' ? 'alert' : 'status'} className="text-2xs text-muted-foreground">{resolveLocalizedMessage(c.notice, t)}</p>}
  </section>;
}
