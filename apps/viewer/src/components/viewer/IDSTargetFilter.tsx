/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { FilterGroupEditor } from './FilterGroupEditor';

/** These controls affect the next check; a displayed report keeps its own scope. */
export function IDSTargetFilter({ modelId }: { modelId?: string }) {
  const { t } = useTranslation();
  const filter = useViewerStore(state => state.idsTargetFilter);
  const setFilter = useViewerStore(state => state.setIdsTargetFilter);
  const loading = useViewerStore(state => state.idsLoading);
  const models = useViewerStore(state => state.models);
  return <section className="border-b p-3 space-y-2 text-xs" aria-label={t('idsPanel.targetFilter.title')}>
    <label className="flex items-center gap-2">
      <input type="checkbox" checked={filter !== null} disabled={loading}
        onChange={event => setFilter(() => event.target.checked ? { groups: [{ rules: [], combinator: 'AND' }], activeGroup: 0 } : null)} />
      {t('idsPanel.targetFilter.enabled')}
    </label>
    <p className="text-muted-foreground">{t(filter ? 'idsPanel.targetFilter.nextRun' : 'idsPanel.targetFilter.wholeModel')}</p>
    {filter && <fieldset disabled={loading}>
      <FilterGroupEditor groups={filter.groups} activeGroup={filter.activeGroup} optionModelId={modelId}
        models={[...models.values()]}
        onChange={update => { if (!loading) setFilter(previous => previous ? update(previous) : null); }} />
    </fieldset>}
  </section>;
}
