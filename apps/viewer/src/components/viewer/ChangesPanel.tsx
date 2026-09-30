/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo, useState } from 'react';
import { Focus, History, RotateCcw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { useTranslation, type TranslationKey } from '@/i18n';
import { useViewerStore } from '@/store';
import { selectChangedEntity } from '@/lib/changes/select-changed-entity';
import { inverseMutationTargets, pruneInverseMutationTargets } from '@/store/slices/mutation-inverse-registry';
import { changeOperations, type ChangeOperation } from '@/lib/changes/change-operations';
import { revertChangeOperation, type RevertRefusal } from '@/lib/changes/revert-change-operation';
import { ExportChangesButton } from './ExportChangesButton';
import { ExportDialog } from './ExportDialog';
import { useChangedModels } from '@/hooks/useUnexportedChanges';
import { totalChangeCount } from '@/lib/export/model-changes';

function refusalKey(reason: RevertRefusal): TranslationKey {
  switch (reason) {
    case 'stale': return 'changesPanel.revertStale';
    case 'edit-mode':
    case 'collab-role':
    case 'model-unavailable': return 'changesPanel.revertPermission';
    case 'newer-conflict': return 'changesPanel.revertUnavailable';
    case 'shared-room': return 'changesPanel.revertSharedRoom';
    case 'missing-view':
    case 'unsupported': return 'changesPanel.revertUnsupported';
  }
}

/** Active undo operations, one federated batch per row, with per-entity Jump. */
export function ChangesPanel({ onClose }: { onClose?: () => void }) {
  const { t } = useTranslation();
  const undoStacks = useViewerStore(state => state.undoStacks);
  const mutationBatchTags = useViewerStore(state => state.mutationBatchTags);
  const mutationVersion = useViewerStore(state => state.mutationVersion);
  const models = useViewerStore(state => state.models);
  const activeModelId = useViewerStore(state => state.activeModelId);
  const hasExportableChanges = totalChangeCount(useChangedModels()) > 0;
  const deltaLabel = models.get(activeModelId ?? '')?.schemaVersion === 'IFC5'
    ? t('exportDialog.changesOnlyLabel.ifc5') : t('exportDialog.changesOnlyLabel.default');
  const [error, setError] = useState<TranslationKey | null>(null);
  const rows = useMemo(() => {
    pruneInverseMutationTargets(useViewerStore);
    return changeOperations(undoStacks, mutationBatchTags, inverseMutationTargets(useViewerStore));
  }, [undoStacks, mutationBatchTags, mutationVersion]);

  const revert = (operation: ChangeOperation) => {
    const result = revertChangeOperation(useViewerStore, operation);
    setError(result.ok ? null : refusalKey(result.reason));
  };

  return <div className="flex h-full min-h-0 flex-col" aria-label={t('changesPanel.title')}>
    <div className="flex items-center gap-2 border-b p-3">
      <History className="h-4 w-4" aria-hidden="true" />
      <h2 className="flex-1 text-sm font-medium">{t('changesPanel.title')}</h2>
      <span className="text-xs text-muted-foreground">{t('changesPanel.rowCount', { count: rows.length })}</span>
      {onClose && <IconButton label={t('changesPanel.close')} className="h-6 w-6" onClick={onClose}><X className="h-3.5 w-3.5" /></IconButton>}
    </div>
    {error && <p role="alert" className="px-3 pt-2 text-xs text-destructive">{t(error)}</p>}
    <div className="min-h-0 flex-1 overflow-y-auto">
      {rows.length === 0
        ? <p className="p-3 text-xs text-muted-foreground">{t('changesPanel.empty')}</p>
        : <ol className="divide-y">{rows.map(operation => <li key={operation.id} className="space-y-2 p-3">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-xs font-medium">
              {operation.modelIds.map(id => models.get(id)?.name ?? id).join(', ')}
            </span>
            <span className="text-2xs text-muted-foreground">{t('changesPanel.rowCount', { count: operation.mutations.length })}</span>
            <Button type="button" variant="outline" size="sm" onClick={() => revert(operation)}>
              <RotateCcw className="h-3 w-3" aria-hidden="true" />{t('changesPanel.revert')}
            </Button>
          </div>
          {operation.entities.length === 0 && <p className="text-xs text-muted-foreground">{
            operation.mutations.every(mutation => mutation.attributeName?.startsWith('georef.'))
              ? t('changesPanel.georeference') : t('changesPanel.modelMetadata')
          }</p>}
          <ul className="space-y-1">{operation.entities.map(({ modelId, entityId }) => {
            const model = models.get(modelId);
            const type = model?.ifcDataStore?.entities.getTypeName(entityId) ?? 'IFC';
            const entity = t('changesPanel.entity', { type, id: entityId });
            const name = model?.ifcDataStore?.entities.getName(entityId);
            return <li key={`${modelId}:${entityId}`}>
              <button type="button" className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs hover:bg-accent"
                aria-label={t('changesPanel.jump', { entity, model: model?.name ?? modelId })}
                onClick={() => selectChangedEntity(modelId, entityId)}>
                <Focus className="h-3 w-3 shrink-0" aria-hidden="true" />
                <span className="truncate">{entity}{name ? ` — ${name}` : ''}</span>
              </button>
            </li>;
          })}</ul>
        </li>)}</ol>}
    </div>
    <div className="flex flex-wrap gap-2 border-t p-3">
      <ExportChangesButton surface="changes_panel" trigger={<Button type="button" size="sm" disabled={!hasExportableChanges}>{t('exportChangesButton.buttonLabel')}</Button>} />
      <ExportDialog surface="changes_panel" initialChangesOnly trigger={<Button type="button" variant="outline" size="sm" disabled={rows.length === 0}>{deltaLabel}</Button>} />
    </div>
  </div>;
}
