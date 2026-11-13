/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { resolveEntityRef } from '@/store/resolveEntityRef';
import { mutationDenial } from '@/store/mutation-permission';
import { effectiveTreeEntityName } from '../hierarchy/effectiveTypeEntities';
import { effectiveListTypeName } from '@/lib/lists/effective-provider-entities';
import { entityName } from '@/lib/commands/modeling/authored-kinds';
import { Button } from '@/components/ui/button';
import { CommitField } from './InspectorControls';
import { runInspectorEdit } from './inspector-edits';

/** #9389: show the whole selection; a shared Name edit is one transaction. */
export function MultiSelectionInspector({ onClose }: { onClose?: () => void }) {
  const { t } = useTranslation();
  const state = useViewerStore();
  const items = [...state.selectedEntityIds].flatMap(globalId => {
    const ref = resolveEntityRef(globalId);
    const store = state.models.get(ref.modelId)?.ifcDataStore;
    const view = state.mutationViews.get(ref.modelId);
    if (!store || view?.isDeleted(ref.expressId)) return [];
    return [{
      ...ref, globalId,
      name: entityName({ dataStore: store, view }, ref.expressId),
      label: effectiveTreeEntityName(store, view, ref.expressId),
      type: effectiveListTypeName(store, view, ref.expressId),
    }];
  });
  const common = items.every(item => item.name === items[0]?.name) ? items[0]?.name ?? '' : '';
  const denied = items.length === 0 || items.some(item => mutationDenial(state, item.modelId) !== null);
  return <div data-multi-selection-inspector className="flex h-full min-h-0 flex-col">
    <div className="flex items-center gap-2 border-b border-border p-3">
      <h2 className="flex-1 text-xs font-medium">{t('modelInspector.multiple', { count: items.length })}</h2>
      {onClose && <Button size="sm" variant="ghost" onClick={onClose}>{t('modelInspector.close')}</Button>}
    </div>
    <div className="space-y-2 border-b border-border p-3">
      <CommitField value={common} ariaLabel={t('modelInspector.name.label')} readOnly={denied}
        onCommit={name => !denied && runInspectorEdit(items[0].modelId, tx => {
          for (const item of items) {
            if (!tx.store.setAttribute(item.modelId, item.expressId, 'Name', name, item.name)) throw new Error('Selection changed');
          }
          return [];
        })} />
      <Button size="sm" variant="outline" onClick={() => state.showWorkspacePanel('properties')}>{t('modelInspector.properties')}</Button>
    </div>
    <ul className="min-h-0 flex-1 overflow-y-auto p-2">
      {items.map(item => <li key={item.globalId}>
        <Button size="sm" variant="ghost" className="h-auto w-full justify-start whitespace-normal text-left"
          onClick={() => state.setSelectedEntityId(item.globalId)}>
          {item.label} · {item.type} #{item.expressId}
        </Button>
      </li>)}
    </ul>
  </div>;
}
